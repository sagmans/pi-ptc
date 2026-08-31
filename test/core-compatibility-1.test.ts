import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createCoreBindings,
	createFactoryExecutor,
	createOfficialExecutor,
	type DispatchLogEntry,
	type DispatchProgress,
} from "../src/bridge.ts";
import { ToolCallError } from "../src/canonical.ts";
import { DISPATCH_EVENT, DISPATCH_LOG_TYPE } from "../src/config.ts";
import { createScheduler } from "../src/scheduler.ts";
import {
	BINDING_SIGNAL,
	EARLY_NATIVE_ABORT_MESSAGE,
	fakeFactoryTools,
	nextTurn,
	OPERATION_ABORTED_MESSAGE,
	PARTIAL_CANCEL_TEXT,
	PRIVATE_WRITE_CONTENT,
	QUEUED_ABORT_FIRST_PATH,
	QUEUED_ABORT_SECOND_PATH,
	SCHEDULER_ABORT_MESSAGE,
} from "./support/tool-bindings-harness.ts";

test("bridge snapshots args, returns canonical JSON, and records dispatch", async () => {
	const logs: unknown[] = [];
	const events: unknown[] = [];
	const bindings = createCoreBindings({
		execute: async (name, args) => {
			assert.equal(name, "read");
			assert.deepEqual(args, { path: "a.txt" });
			return {
				content: [{ type: "text", text: "hello" }],
				details: { truncation: { truncated: false } },
			};
		},
		scheduler: createScheduler(2),
		appendLog: (entry) => {
			logs.push(entry);
		},
		emit: (name, payload) => {
			events.push({ name, payload });
		},
	});

	const value = await bindings.read({ path: "a.txt" }, BINDING_SIGNAL);
	assert.deepEqual(value, { text: "hello", truncation: { truncated: false } });
	assert.deepEqual(logs, [
		{
			customType: DISPATCH_LOG_TYPE,
			name: "read",
			args: { path: "a.txt" },
			isError: false,
		},
	]);
	assert.deepEqual(events, [
		{
			name: DISPATCH_EVENT,
			payload: {
				name: "read",
				args: { path: "a.txt" },
				isError: false,
			},
		},
	]);
});

test("bridge forwards the runtime invocation signal to factory execution", async () => {
	const invocationSignal = new AbortController().signal;
	let receivedSignal: AbortSignal | undefined;
	const bindings = createCoreBindings({
		execute: async (_name, _args, signal) => {
			receivedSignal = signal;
			return { content: [] };
		},
		scheduler: createScheduler(2),
	});

	await bindings.read({ path: "a.txt" }, invocationSignal);

	assert.equal(receivedSignal, invocationSignal);
});

test("bridge terminalizes cancelled partial work before binding rejection settles", async () => {
	const controller = new AbortController();
	const order: string[] = [];
	const reported: DispatchProgress[] = [];
	let markExecutorStarted!: () => void;
	const executorStarted = new Promise<void>((resolve) => {
		markExecutorStarted = resolve;
	});
	const bindings = createCoreBindings({
		execute: async (_name, _args, signal, onUpdate) => {
			markExecutorStarted();
			assert.equal(signal, controller.signal);
			onUpdate?.({ content: [{ type: "text", text: PARTIAL_CANCEL_TEXT }] });
			await new Promise<void>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error(OPERATION_ABORTED_MESSAGE)), {
					once: true,
				});
			});
			return { content: [] };
		},
		scheduler: createScheduler(2),
		reportDispatch: (progress) => {
			reported.push(progress);
			order.push(
				progress.status === "start" && progress.result ? "partial-start" : progress.status,
			);
		},
	});

	const pending = bindings.read({ path: "a.txt" }, controller.signal);
	const settlementObserved = pending.then(
		() => {
			order.push("settled");
		},
		() => {
			order.push("settled");
		},
	);
	await executorStarted;
	controller.abort();
	await assert.rejects(pending, SCHEDULER_ABORT_MESSAGE);
	await settlementObserved;

	assert.deepEqual(order, ["start", "partial-start", "err", "settled"]);
	assert.deepEqual(
		reported.map((progress) => progress.status),
		["start", "start", "err"],
	);
	assert.equal(reported[1]?.result?.content[0]?.text, PARTIAL_CANCEL_TEXT);
	assert.equal(reported.filter((progress) => progress.status === "err").length, 1);
	assert.equal(reported.at(-1)?.status, "err");
});

test("bridge removes an aborted queued dispatch before factory execution", async () => {
	const executedPaths: string[] = [];
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const bindings = createCoreBindings({
		execute: async (_name, args) => {
			const path = (args as { path: string }).path;
			executedPaths.push(path);
			if (path === QUEUED_ABORT_FIRST_PATH) await firstGate;
			return { content: [{ type: "text", text: path }] };
		},
		scheduler: createScheduler(1),
	});
	const queuedController = new AbortController();
	const first = bindings.read({ path: QUEUED_ABORT_FIRST_PATH }, BINDING_SIGNAL);
	const queued = bindings.read({ path: QUEUED_ABORT_SECOND_PATH }, queuedController.signal);
	const queuedRejection = assert.rejects(queued, SCHEDULER_ABORT_MESSAGE);

	queuedController.abort();
	releaseFirst();
	await Promise.all([first, queuedRejection]);

	assert.deepEqual(executedPaths, [QUEUED_ABORT_FIRST_PATH]);
});

test("bridge rejects lossless-invalid args before execute", async () => {
	let executed = false;
	const bindings = createCoreBindings({
		execute: async () => {
			executed = true;
			return { content: [] };
		},
		scheduler: createScheduler(2),
	});
	await assert.rejects(
		() => bindings.read({ path: undefined as unknown as string }, BINDING_SIGNAL),
		/lossless JSON/,
	);
	assert.equal(executed, false);
});

test("bridge bounds durable arguments and rejects quarantined side effects", async () => {
	const logs: DispatchLogEntry[] = [];
	const events: Array<{ name: string; payload: unknown }> = [];
	let acceptSideEffects = true;
	const bindings = createCoreBindings({
		execute: async () => ({ content: [] }),
		scheduler: createScheduler(1),
		appendLog: (entry) => logs.push(entry),
		emit: (name, payload) => events.push({ name, payload }),
		acceptSideEffects: () => acceptSideEffects,
	});

	await bindings.write({ path: "private.txt", content: PRIVATE_WRITE_CONTENT }, BINDING_SIGNAL);
	acceptSideEffects = false;
	await bindings.write({ path: "late.txt", content: PRIVATE_WRITE_CONTENT }, BINDING_SIGNAL);

	assert.equal(logs.length, 1);
	assert.equal(events.length, 1);
	assert.deepEqual(logs[0]?.args, { path: "private.txt" });
	assert.deepEqual((events[0]?.payload as { args?: unknown } | undefined)?.args, {
		path: "private.txt",
	});
	assert.equal(JSON.stringify({ logs, events }).includes(PRIVATE_WRITE_CONTENT), false);
});

test("bridge turns factory failure into ToolCallError", async () => {
	const logs: Array<{ isError: boolean }> = [];
	const bindings = createCoreBindings({
		execute: async () => {
			throw new Error("missing");
		},
		scheduler: createScheduler(2),
		appendLog: (entry) => {
			logs.push({ isError: entry.isError });
		},
	});
	await assert.rejects(
		() => bindings.read({ path: "gone.txt" }, BINDING_SIGNAL),
		(error: unknown) => {
			assert.ok(error instanceof ToolCallError);
			assert.equal(error.toolName, "read");
			assert.equal(error.message, "missing");
			return true;
		},
	);
	assert.deepEqual(logs, [{ isError: true }]);
});

test("bridge classifies exclusive work so bash waits for reads", async () => {
	const started: string[] = [];
	let releaseRead!: () => void;
	const readGate = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	const bindings = createCoreBindings({
		execute: async (name) => {
			started.push(name);
			if (name === "read") await readGate;
			return { content: [{ type: "text", text: name }] };
		},
		scheduler: createScheduler(2),
	});
	const read = bindings.read({ path: "a.txt" }, BINDING_SIGNAL);
	const bash = bindings.bash({ command: "true" }, BINDING_SIGNAL);
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(started, ["read"]);
	releaseRead();
	await Promise.all([read, bash]);
	assert.deepEqual(started, ["read", "bash"]);
});

test("official executor accepts only cwd so it cannot capture an invocation signal", () => {
	assert.equal(createOfficialExecutor.length, 1);
});

test("official executor reads a real file through the factory", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ptc-bridge-"));
	writeFileSync(join(dir, "note.txt"), "factory-ok\n");
	const execute = createOfficialExecutor(dir);
	const bindings = createCoreBindings({
		execute,
		scheduler: createScheduler(2),
	});
	assert.deepEqual(await bindings.read({ path: "note.txt" }, BINDING_SIGNAL), {
		text: "factory-ok\n",
	});
});

test("factory executor drains native read work before surfacing abort", async () => {
	let markStarted!: () => void;
	let releaseOwnedWork!: () => void;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const ownedWork = new Promise<void>((resolve) => {
		releaseOwnedWork = resolve;
	});
	let ownedWorkSettled = false;
	let executorReturned = false;
	const controller = new AbortController();
	const execute = createFactoryExecutor(
		fakeFactoryTools(async (_id, _args, signal) => {
			markStarted();
			if (signal) {
				return await new Promise((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							reject(new Error(EARLY_NATIVE_ABORT_MESSAGE));
							void ownedWork.then(() => {
								ownedWorkSettled = true;
							});
						},
						{ once: true },
					);
				});
			}
			await ownedWork;
			ownedWorkSettled = true;
			return { content: [{ type: "text", text: "done" }] };
		}),
	);
	const pending = execute("read", { path: "a.txt" }, controller.signal);
	void pending.then(
		() => {
			executorReturned = true;
		},
		() => {
			executorReturned = true;
		},
	);

	await started;
	controller.abort();
	await nextTurn();
	const returnedBeforeOwnedWork = executorReturned;
	const settledBeforeRelease = ownedWorkSettled;
	releaseOwnedWork();
	await ownedWork;

	await assert.rejects(pending, SCHEDULER_ABORT_MESSAGE);
	assert.equal(returnedBeforeOwnedWork, false);
	assert.equal(settledBeforeRelease, false);
	assert.equal(ownedWorkSettled, true);
});

test("factory executor forwards abort to natively draining tools", async () => {
	const controller = new AbortController();
	let receivedSignal: AbortSignal | undefined;
	const execute = createFactoryExecutor(
		fakeFactoryTools(async (_id, _args, signal) => {
			receivedSignal = signal;
			return { content: [] };
		}),
	);

	await execute("bash", { command: "true" }, controller.signal);

	assert.equal(receivedSignal, controller.signal);
});
