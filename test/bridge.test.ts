import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as bridge from "../src/bridge.ts";
import {
	createCoreBindings,
	createFactoryExecutor,
	createOfficialExecutor,
	type DispatchLogEntry,
	type DispatchProgress,
	type FactoryToolSet,
	formatDispatchLine,
} from "../src/bridge.ts";
import { ToolCallError } from "../src/canonical.ts";
import { CORE_TOOL_NAMES, DISPATCH_EVENT, DISPATCH_LOG_TYPE } from "../src/config.ts";
import type { JsonValue } from "../src/json.ts";
import type { BindingFn } from "../src/runtime-contract.ts";
import { createScheduler, type Scheduler } from "../src/scheduler.ts";
import type { ToolCatalogEntry } from "../src/tool-catalog.ts";
import type {
	NestedToolDispatchRequest,
	NestedToolDispatchResult,
	NestedToolRuntimeResult,
	ToolExecutor,
} from "../src/tool-executor.ts";

const BINDING_SIGNAL = new AbortController().signal;
const QUEUED_ABORT_FIRST_PATH = "first.txt";
const QUEUED_ABORT_SECOND_PATH = "second.txt";
const OPERATION_ABORTED_MESSAGE = "Operation aborted";
const SCHEDULER_ABORT_MESSAGE = new RegExp(OPERATION_ABORTED_MESSAGE);
const EARLY_NATIVE_ABORT_MESSAGE = "native aborted before owned work settled";
const PARTIAL_CANCEL_TEXT = "partial output";
const PRIVATE_WRITE_CONTENT = "PRIVATE_WRITE_CONTENT".repeat(100);
const GENERIC_TOOL_NAME = "mcp.server/call[odd name]";
const OTHER_GENERIC_TOOL_NAME = "__proto__";
const INACTIVE_TOOL_NAME = "inactive.tool";
const GENERIC_REDACTION_MARKER = "[REDACTED]";
const GENERIC_FAILED_MESSAGE = "tool failed";
const CONTROLLED_TOOL_NAME_CASES = [
	{ raw: "before\u001b[31mafter", safe: "beforeafter" },
	{ raw: "before\u001b]0;unsafe-title\u0007after", safe: "beforeafter" },
	{ raw: "before\u001b_payload\u001b\\after", safe: "beforeafter" },
	{ raw: "before\nafter", safe: "beforeafter" },
	{ raw: "before\u009b31mafter", safe: "beforeafter" },
] as const;
const CONTROLLED_TOOL_NAME = CONTROLLED_TOOL_NAME_CASES.map(({ raw }) => raw).join(":");
const OVERSIZED_TOOL_NAME = "tool-name".repeat(1_000);
const MAX_FORMATTED_TOOL_LINE_BYTES = 512;
const COMPOUND_CREDENTIAL_VALUES = [
	"private-access",
	"private-refresh",
	"private-auth",
	"private-bearer",
	"private-session",
] as const;

type ToolBindingsFactory = (
	snapshot: readonly ToolCatalogEntry[],
	executor: ToolExecutor,
	scheduler: Scheduler,
	reporting: {
		appendLog?: (entry: DispatchLogEntry) => void;
		emit?: (name: string, payload: unknown) => void;
		acceptSideEffects?: () => boolean;
		reportDispatch?: (progress: DispatchProgress) => void;
	},
) => Record<string, BindingFn>;

function createGenericBindings(
	snapshot: readonly ToolCatalogEntry[],
	executor: ToolExecutor,
	scheduler = createScheduler(2),
	reporting: Parameters<ToolBindingsFactory>[3] = {},
): Record<string, BindingFn> {
	const factory = Reflect.get(bridge, "createToolBindings");
	assert.equal(typeof factory, "function", "createToolBindings export must exist");
	return (factory as ToolBindingsFactory)(snapshot, executor, scheduler, reporting);
}

function catalogEntry(name: string, executionMode?: "parallel" | "sequential"): ToolCatalogEntry {
	return {
		name,
		definition: { name },
		executable: {
			parameters: { type: "object" },
			...(executionMode ? { executionMode } : {}),
			async execute() {
				throw new Error("catalog executable must not run directly from bindings");
			},
		},
	};
}

function dispatchResult(
	request: NestedToolDispatchRequest,
	result: NestedToolRuntimeResult,
	isError = false,
): NestedToolDispatchResult {
	return {
		toolCallId: `nested:${request.name}`,
		name: request.name,
		rawArgs: request.args,
		result,
		isError,
	};
}

function toolExecutor(
	dispatch: (request: NestedToolDispatchRequest) => Promise<NestedToolDispatchResult>,
): ToolExecutor {
	return { dispatch };
}

async function nextTurn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

test("generic bindings preserve controlled exact names across internal channels", async () => {
	const logs: DispatchLogEntry[] = [];
	const events: Array<{ name: string; payload: unknown }> = [];
	const reported: DispatchProgress[] = [];
	let executedName: string | undefined;
	const bindings = createGenericBindings(
		[catalogEntry(CONTROLLED_TOOL_NAME)],
		toolExecutor(async (request) => {
			executedName = request.name;
			return dispatchResult(request, { content: [] });
		}),
		createScheduler(2),
		{
			appendLog: (entry) => logs.push(entry),
			emit: (name, payload) => events.push({ name, payload }),
			reportDispatch: (progress) => reported.push(progress),
		},
	);

	await bindings[CONTROLLED_TOOL_NAME]?.({}, BINDING_SIGNAL);

	assert.equal(executedName, CONTROLLED_TOOL_NAME);
	assert.equal(logs[0]?.name, CONTROLLED_TOOL_NAME);
	assert.equal((events[0]?.payload as { name?: unknown } | undefined)?.name, CONTROLLED_TOOL_NAME);
	assert.deepEqual(
		reported.map(({ name }) => name),
		[CONTROLLED_TOOL_NAME, CONTROLLED_TOOL_NAME],
	);
});

test("dispatch formatting sanitizes and bounds arbitrary tool names", () => {
	for (const { raw, safe } of CONTROLLED_TOOL_NAME_CASES) {
		assert.equal(formatDispatchLine({ name: raw, args: {}, status: "ok" }), `${safe} ok`);
	}
	const oversized = formatDispatchLine({ name: OVERSIZED_TOOL_NAME, args: {}, status: "ok" });
	assert.ok(Buffer.byteLength(oversized, "utf8") <= MAX_FORMATTED_TOOL_LINE_BYTES);
	assert.equal(oversized.includes(OVERSIZED_TOOL_NAME), false);
});

test("generic bindings expose only a fixed exact snapshot through a null prototype", async () => {
	const snapshot = [catalogEntry(GENERIC_TOOL_NAME), catalogEntry(OTHER_GENERIC_TOOL_NAME)];
	const called: Array<{ name: string; args: unknown }> = [];
	const bindings = createGenericBindings(
		snapshot,
		toolExecutor(async (request) => {
			called.push({ name: request.name, args: request.args });
			return dispatchResult(request, {
				content: [{ type: "text", text: `called:${request.name}` }],
			});
		}),
	);
	snapshot.push(catalogEntry(INACTIVE_TOOL_NAME));

	assert.equal(Object.getPrototypeOf(bindings), null);
	assert.deepEqual(Object.keys(bindings), [GENERIC_TOOL_NAME, OTHER_GENERIC_TOOL_NAME]);
	assert.equal(bindings.ptc, undefined);
	assert.equal(bindings[INACTIVE_TOOL_NAME], undefined);
	assert.deepEqual(await bindings[GENERIC_TOOL_NAME]?.({ exact: true }, BINDING_SIGNAL), {
		text: `called:${GENERIC_TOOL_NAME}`,
		content: [{ type: "text", text: `called:${GENERIC_TOOL_NAME}` }],
	});
	assert.deepEqual(await bindings[OTHER_GENERIC_TOOL_NAME]?.({}, BINDING_SIGNAL), {
		text: `called:${OTHER_GENERIC_TOOL_NAME}`,
		content: [{ type: "text", text: `called:${OTHER_GENERIC_TOOL_NAME}` }],
	});
	assert.deepEqual(called, [
		{ name: GENERIC_TOOL_NAME, args: { exact: true } },
		{ name: OTHER_GENERIC_TOOL_NAME, args: {} },
	]);
});

test("generic bindings classify parallel and sequential entries through one scheduler", async () => {
	const firstName = "parallel.one";
	const secondName = "parallel.two";
	const sequentialName = "sequential.after";
	const started: string[] = [];
	let releaseParallel!: () => void;
	const parallelGate = new Promise<void>((resolve) => {
		releaseParallel = resolve;
	});
	const bindings = createGenericBindings(
		[
			catalogEntry(firstName, "parallel"),
			catalogEntry(secondName, "parallel"),
			catalogEntry(sequentialName, "sequential"),
		],
		toolExecutor(async (request) => {
			started.push(request.name);
			if (request.name !== sequentialName) await parallelGate;
			return dispatchResult(request, { content: [] });
		}),
		createScheduler(2),
	);

	const first = bindings[firstName]?.({}, BINDING_SIGNAL);
	const second = bindings[secondName]?.({}, BINDING_SIGNAL);
	await nextTurn();
	assert.deepEqual(started, [firstName, secondName]);
	const sequential = bindings[sequentialName]?.({}, BINDING_SIGNAL);
	await nextTurn();
	assert.deepEqual(started, [firstName, secondName]);
	releaseParallel();
	await Promise.all([first, second, sequential]);
	assert.deepEqual(started, [firstName, secondName, sequentialName]);
});

test("generic bindings cancel queued work before executor dispatch", async () => {
	const firstName = "parallel.first";
	const queuedName = "parallel.queued";
	const started: string[] = [];
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const bindings = createGenericBindings(
		[catalogEntry(firstName, "parallel"), catalogEntry(queuedName, "parallel")],
		toolExecutor(async (request) => {
			started.push(request.name);
			if (request.name === firstName) await firstGate;
			return dispatchResult(request, { content: [] });
		}),
		createScheduler(1),
	);
	const controller = new AbortController();
	const first = bindings[firstName]?.({}, BINDING_SIGNAL);
	const queued = bindings[queuedName]?.({}, controller.signal);
	assert.ok(queued);
	const rejection = assert.rejects(queued, SCHEDULER_ABORT_MESSAGE);

	controller.abort();
	releaseFirst();
	await Promise.all([first, rejection]);
	assert.deepEqual(started, [firstName]);
});

test("generic bindings report partial and final native progress and bounded side effects", async () => {
	const logs: DispatchLogEntry[] = [];
	const events: Array<{ name: string; payload: unknown }> = [];
	const reported: DispatchProgress[] = [];
	const args = { path: "remote/item", token: "private-token" };
	const bindings = createGenericBindings(
		[catalogEntry(GENERIC_TOOL_NAME)],
		toolExecutor(async (request) => {
			await request.onUpdate?.({
				content: [{ type: "text", text: "partial" }],
				details: { stage: "partial" },
			});
			return dispatchResult(request, {
				content: [{ type: "text", text: "final" }],
				details: { stage: "final" },
				usage: { totalTokens: 7 },
			});
		}),
		createScheduler(2),
		{
			appendLog: (entry) => logs.push(entry),
			emit: (name, payload) => events.push({ name, payload }),
			reportDispatch: (progress) => reported.push(progress),
		},
	);

	assert.deepEqual(await bindings[GENERIC_TOOL_NAME]?.(args, BINDING_SIGNAL), {
		text: "final",
		content: [{ type: "text", text: "final" }],
		details: { stage: "final" },
		usage: { totalTokens: 7 },
	});
	assert.deepEqual(
		reported.map(({ id, name, status, preview }) => ({ id, name, status, preview })),
		[
			{ id: 1, name: GENERIC_TOOL_NAME, status: "start", preview: undefined },
			{ id: 1, name: GENERIC_TOOL_NAME, status: "start", preview: undefined },
			{ id: 1, name: GENERIC_TOOL_NAME, status: "ok", preview: "final" },
		],
	);
	assert.deepEqual(reported[1]?.result?.details, { stage: "partial" });
	assert.deepEqual(reported[2]?.result?.details, { stage: "final" });
	assert.deepEqual(logs, [
		{
			customType: DISPATCH_LOG_TYPE,
			name: GENERIC_TOOL_NAME,
			args: { path: "remote/item", token: GENERIC_REDACTION_MARKER },
			isError: false,
		},
	]);
	assert.deepEqual(events, [
		{
			name: DISPATCH_EVENT,
			payload: {
				name: GENERIC_TOOL_NAME,
				args: { path: "remote/item", token: GENERIC_REDACTION_MARKER },
				isError: false,
			},
		},
	]);
});

test("generic side-effect logs redact compound credential keys recursively", async () => {
	const logs: DispatchLogEntry[] = [];
	const args: JsonValue = {
		nested: {
			access_token: COMPOUND_CREDENTIAL_VALUES[0],
			refreshToken: COMPOUND_CREDENTIAL_VALUES[1],
		},
		array: [
			{ authToken: COMPOUND_CREDENTIAL_VALUES[2] },
			{ bearer_token: COMPOUND_CREDENTIAL_VALUES[3] },
			{ session_cookie: COMPOUND_CREDENTIAL_VALUES[4] },
		],
	};
	const bindings = createGenericBindings(
		[catalogEntry(GENERIC_TOOL_NAME)],
		toolExecutor(async (request) => dispatchResult(request, { content: [] })),
		createScheduler(2),
		{ appendLog: (entry) => logs.push(entry) },
	);

	await bindings[GENERIC_TOOL_NAME]?.(args, BINDING_SIGNAL);

	assert.deepEqual(logs[0]?.args, {
		nested: {
			access_token: GENERIC_REDACTION_MARKER,
			refreshToken: GENERIC_REDACTION_MARKER,
		},
		array: [
			{ authToken: GENERIC_REDACTION_MARKER },
			{ bearer_token: GENERIC_REDACTION_MARKER },
			{ session_cookie: GENERIC_REDACTION_MARKER },
		],
	});
	const serialized = JSON.stringify(logs);
	for (const value of COMPOUND_CREDENTIAL_VALUES) assert.equal(serialized.includes(value), false);
});

test("generic bindings project lossless text image details and usage", async () => {
	const revokedBlock = Proxy.revocable({}, {});
	revokedBlock.revoke();
	const hostileBlock = new Proxy(
		{},
		{
			get() {
				throw new Error("hostile content block");
			},
		},
	);
	const result: NestedToolRuntimeResult = {
		content: [
			{ type: "text", text: "first", ignored: true },
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png", ignored: true },
			{ type: "text", text: "second" },
			{ type: "image", data: "missing mime" },
			{ type: "audio", data: "ignored", mimeType: "audio/wav" },
			hostileBlock,
			revokedBlock.proxy,
			null,
		],
		details: { structuredContent: { answer: 42 } },
		usage: { input: 3, output: 5 },
	};
	const bindings = createGenericBindings(
		[catalogEntry(GENERIC_TOOL_NAME)],
		toolExecutor(async (request) => dispatchResult(request, result)),
	);

	assert.deepEqual(await bindings[GENERIC_TOOL_NAME]?.({}, BINDING_SIGNAL), {
		text: "firstsecond",
		content: [
			{ type: "text", text: "first" },
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			{ type: "text", text: "second" },
		],
		details: { structuredContent: { answer: 42 } },
		usage: { input: 3, output: 5 },
	});
});

test("generic bindings treat revoked result and content proxies as malformed", async () => {
	const revokedResult = Proxy.revocable({}, {});
	revokedResult.revoke();
	const revokedContent = Proxy.revocable([], {});
	revokedContent.revoke();
	const fullResultName = "revoked.result";
	const contentName = "revoked.content";
	const errorName = "revoked.error";
	const bindings = createGenericBindings(
		[catalogEntry(fullResultName), catalogEntry(contentName), catalogEntry(errorName)],
		toolExecutor(async (request) => {
			if (request.name === contentName) {
				return dispatchResult(request, {
					content: revokedContent.proxy,
					details: { safe: true },
				} as NestedToolRuntimeResult);
			}
			return dispatchResult(
				request,
				revokedResult.proxy as NestedToolRuntimeResult,
				request.name === errorName,
			);
		}),
	);

	assert.deepEqual(await bindings[fullResultName]?.({}, BINDING_SIGNAL), {
		text: "",
		content: [],
	});
	assert.deepEqual(await bindings[contentName]?.({}, BINDING_SIGNAL), {
		text: "",
		content: [],
		details: { safe: true },
	});
	await assert.rejects(
		() => bindings[errorName]?.({}, BINDING_SIGNAL),
		(error: unknown) => {
			assert.ok(error instanceof ToolCallError);
			assert.equal(error.message, GENERIC_FAILED_MESSAGE);
			return true;
		},
	);
});

test("generic bindings omit incompatible optional values but retain raw render details", async () => {
	const cyclicDetails: { self?: unknown } = {};
	cyclicDetails.self = cyclicDetails;
	const cyclicUsage: { self?: unknown } = {};
	cyclicUsage.self = cyclicUsage;
	const reported: DispatchProgress[] = [];
	const bindings = createGenericBindings(
		[catalogEntry(GENERIC_TOOL_NAME)],
		toolExecutor(async (request) =>
			dispatchResult(request, {
				content: [{ type: "text", text: "safe" }],
				details: cyclicDetails,
				usage: cyclicUsage,
			}),
		),
		createScheduler(2),
		{ reportDispatch: (progress) => reported.push(progress) },
	);

	assert.deepEqual(await bindings[GENERIC_TOOL_NAME]?.({}, BINDING_SIGNAL), {
		text: "safe",
		content: [{ type: "text", text: "safe" }],
	});
	assert.equal(reported.at(-1)?.result?.details, cyclicDetails);

	const throwingResult = Object.defineProperties(
		{ content: [{ type: "text", text: "still safe" }] },
		{
			details: {
				enumerable: true,
				get() {
					throw new Error("details getter");
				},
			},
			usage: {
				enumerable: true,
				get() {
					throw new Error("usage getter");
				},
			},
		},
	) as NestedToolRuntimeResult;
	const throwingBindings = createGenericBindings(
		[catalogEntry(GENERIC_TOOL_NAME)],
		toolExecutor(async (request) => dispatchResult(request, throwingResult)),
	);
	await assert.doesNotReject(async () => {
		assert.deepEqual(await throwingBindings[GENERIC_TOOL_NAME]?.({}, BINDING_SIGNAL), {
			text: "still safe",
			content: [{ type: "text", text: "still safe" }],
		});
	});
});

test("generic final errors become catchable ToolCallError after native finalization", async () => {
	const bindings = createGenericBindings(
		[catalogEntry(GENERIC_TOOL_NAME), catalogEntry(OTHER_GENERIC_TOOL_NAME)],
		toolExecutor(async (request) => {
			if (request.name === OTHER_GENERIC_TOOL_NAME) {
				return dispatchResult(request, { content: [{ type: "image", data: "x" }] }, true);
			}
			return dispatchResult(
				request,
				{
					content: [
						{ type: "text", text: "patched " },
						{ type: "text", text: "failure" },
						{ type: "text", text: 42 },
					],
				},
				true,
			);
		}),
	);

	for (const [name, message] of [
		[GENERIC_TOOL_NAME, "patched failure"],
		[OTHER_GENERIC_TOOL_NAME, GENERIC_FAILED_MESSAGE],
	] as const) {
		let caught: unknown;
		try {
			await bindings[name]?.({}, BINDING_SIGNAL);
		} catch (error) {
			caught = error;
		}
		assert.ok(caught instanceof ToolCallError);
		assert.equal(caught.toolName, name);
		assert.equal(caught.message, message);
	}
});

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
