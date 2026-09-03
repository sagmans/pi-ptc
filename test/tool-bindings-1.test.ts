import { strict as assert } from "node:assert";
import test from "node:test";
import { ToolCallError } from "../src/canonical.ts";
import { DISPATCH_EVENT, DISPATCH_LOG_TYPE } from "../src/config.ts";
import type { DispatchLogEntry, DispatchProgress } from "../src/dispatch-contract.ts";
import { formatDispatchLine } from "../src/dispatch-format.ts";
import type { JsonValue } from "../src/json.ts";
import { createScheduler } from "../src/scheduler.ts";
import type { NestedToolRuntimeResult } from "../src/tool-executor.ts";
import {
	BINDING_SIGNAL,
	COMPOUND_CREDENTIAL_VALUES,
	CONTROLLED_TOOL_NAME,
	CONTROLLED_TOOL_NAME_CASES,
	catalogEntry,
	createGenericBindings,
	dispatchResult,
	GENERIC_FAILED_MESSAGE,
	GENERIC_REDACTION_MARKER,
	GENERIC_TOOL_NAME,
	INACTIVE_TOOL_NAME,
	MAX_FORMATTED_TOOL_LINE_BYTES,
	nextTurn,
	OTHER_GENERIC_TOOL_NAME,
	OVERSIZED_TOOL_NAME,
	SCHEDULER_ABORT_MESSAGE,
	toolExecutor,
} from "./support/tool-bindings-harness.ts";

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

test("bindings preserve tool-owned timeout arguments", async () => {
	let executedArgs: unknown;
	const bindings = createGenericBindings(
		[catalogEntry("bash")],
		toolExecutor(async (request) => {
			executedArgs = request.args;
			return dispatchResult(request, { content: [] });
		}),
	);

	await bindings.bash?.({ command: "sleep 1", timeout: 300 }, BINDING_SIGNAL);

	assert.deepEqual(executedArgs, { command: "sleep 1", timeout: 300 });
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

test("generic bindings keep raw progress in attachments and bound side effects", async () => {
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
	assert.equal(reported[1]?.result, undefined);
	assert.equal(reported[2]?.result, undefined);
	assert.deepEqual(
		reported.map(({ args: progressArgs }) => progressArgs),
		Array.from({ length: 3 }, () => ({
			path: "remote/item",
			token: GENERIC_REDACTION_MARKER,
		})),
	);
	const serializedProgress = JSON.stringify(reported);
	assert.equal(serializedProgress.includes("private-token"), false);
	assert.equal(serializedProgress.includes('"stage"'), false);
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
