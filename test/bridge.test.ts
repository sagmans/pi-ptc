import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createCoreBindings,
	createFactoryExecutor,
	createOfficialExecutor,
	type DispatchProgress,
	type FactoryToolSet,
	formatDispatchLine,
} from "../src/bridge.ts";
import { ToolCallError } from "../src/canonical.ts";
import { CORE_TOOL_NAMES, DISPATCH_EVENT, DISPATCH_LOG_TYPE } from "../src/config.ts";
import { createScheduler } from "../src/scheduler.ts";

const BINDING_SIGNAL = new AbortController().signal;
const QUEUED_ABORT_FIRST_PATH = "first.txt";
const QUEUED_ABORT_SECOND_PATH = "second.txt";
const OPERATION_ABORTED_MESSAGE = "Operation aborted";
const SCHEDULER_ABORT_MESSAGE = new RegExp(OPERATION_ABORTED_MESSAGE);
const EARLY_NATIVE_ABORT_MESSAGE = "native aborted before owned work settled";
const PARTIAL_CANCEL_TEXT = "partial output";

async function nextTurn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

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
			assert.equal(signal, controller.signal);
			onUpdate?.({ content: [{ type: "text", text: PARTIAL_CANCEL_TEXT }] });
			markExecutorStarted();
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

function fakeFactoryTools(execute: FactoryToolSet["read"]["execute"]): FactoryToolSet {
	return Object.fromEntries(CORE_TOOL_NAMES.map((name) => [name, { execute }])) as FactoryToolSet;
}

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

test("factory executor reserves unique IDs before concurrent calls settle", async () => {
	const ids: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const execute = createFactoryExecutor(
		fakeFactoryTools(async (id) => {
			ids.push(id);
			if (ids.length === 1) await gate;
			return { content: [{ type: "text", text: "ok" }] };
		}),
	);

	const first = execute("read", { path: "a.txt" });
	const second = execute("read", { path: "b.txt" });
	assert.deepEqual(ids, ["ptc:read:1", "ptc:read:2"]);
	release();
	await Promise.all([first, second]);
});

test("factory executor does not reuse an ID after failure", async () => {
	const ids: string[] = [];
	const execute = createFactoryExecutor(
		fakeFactoryTools(async (id) => {
			ids.push(id);
			if (ids.length === 1) throw new Error("failed");
			return { content: [{ type: "text", text: "ok" }] };
		}),
	);

	await assert.rejects(() => execute("read", { path: "a.txt" }), /failed/);
	await execute("read", { path: "b.txt" });
	assert.deepEqual(ids, ["ptc:read:1", "ptc:read:2"]);
});

test("bridge reports one stable dispatch record with its native result", async () => {
	const order: string[] = [];
	const reported: DispatchProgress[] = [];
	const bindings = createCoreBindings({
		execute: async () => {
			order.push("execute");
			return { content: [{ type: "text", text: "hello" }] };
		},
		scheduler: createScheduler(2),
		reportDispatch: (progress) => {
			order.push(progress.status);
			reported.push(progress);
		},
	});
	await bindings.read({ path: "a.txt" }, BINDING_SIGNAL);
	assert.deepEqual(order, ["start", "execute", "ok"]);
	assert.deepEqual(reported, [
		{ id: 1, name: "read", args: { path: "a.txt" }, status: "start" },
		{
			id: 1,
			name: "read",
			args: { path: "a.txt" },
			status: "ok",
			result: {
				content: [{ type: "text", text: "hello" }],
				details: undefined,
				isError: false,
			},
		},
	]);
});

test("bridge keeps bounded tail and head previews for native-like rows", async () => {
	const lines = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join("\n");
	const reported: DispatchProgress[] = [];
	const bindings = createCoreBindings({
		execute: async () => ({ content: [{ type: "text", text: lines }] }),
		scheduler: createScheduler(2),
		reportDispatch: (progress) => {
			reported.push(progress);
		},
	});

	await bindings.bash({ command: "printf lines" }, BINDING_SIGNAL);
	await bindings.grep({ pattern: "line", path: "src" }, BINDING_SIGNAL);

	const settled = reported.filter((progress) => progress.status === "ok");
	assert.deepEqual(
		settled.map(({ result: _result, ...progress }) => progress),
		[
			{
				id: 1,
				name: "bash",
				args: { command: "printf lines" },
				status: "ok",
				preview: "…\nline-3\nline-4\nline-5\nline-6\nline-7\nline-8\nline-9\nline-10",
			},
			{
				id: 2,
				name: "grep",
				args: { pattern: "line", path: "src" },
				status: "ok",
				preview: "line-1\nline-2\nline-3\nline-4\nline-5\nline-6\nline-7\nline-8\n…",
			},
		],
	);
	assert.deepEqual(
		settled.map((progress) => progress.result?.content[0]?.text),
		[lines, lines],
	);
});

test("bridge reports err after factory failure", async () => {
	const statuses: string[] = [];
	const bindings = createCoreBindings({
		execute: async () => {
			throw new Error("missing");
		},
		scheduler: createScheduler(2),
		reportDispatch: (progress) => {
			statuses.push(progress.status);
		},
	});
	await assert.rejects(() => bindings.read({ path: "gone.txt" }, BINDING_SIGNAL), ToolCallError);
	assert.deepEqual(statuses, ["start", "err"]);
});

test("formatDispatchLine names the tool, status, and target", () => {
	assert.equal(
		formatDispatchLine({ name: "read", args: { path: "a.txt" }, status: "start" }),
		"read … a.txt",
	);
	assert.equal(
		formatDispatchLine({ name: "read", args: { path: "a.txt" }, status: "ok" }),
		"read ok a.txt",
	);
	assert.equal(
		formatDispatchLine({ name: "bash", args: { command: "true" }, status: "err" }),
		"bash err true",
	);
	assert.equal(formatDispatchLine({ name: "ls", args: {}, status: "start" }), "ls …");
});
