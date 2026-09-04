import { strict as assert } from "node:assert";
import test from "node:test";

import { LEAK_BLOCK_REASON } from "../src/config.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/host.ts";
import installPtc from "../src/index.ts";
import {
	type CapturedPiSession,
	type PiRuntimeActionsInstallation,
	type PiRuntimeEventFinalizers,
	type PiRuntimeEventFinalizersInstallation,
	type PiRuntimeInstaller,
	type PiRuntimeTool,
	type PiSharedRuntime,
	SUPPORTED_PI_VERSION,
} from "../src/pi-runtime.ts";
import { createPiToolArgumentPreparer } from "../src/pi-runtime-arguments.ts";
import { createToolExecutor, isNestedPtcToolCall } from "../src/tool-executor.ts";
import { createEntry, createSession, type HookContext } from "./support/tool-executor-harness.ts";

test("AsyncLocalStorage marker remains scoped and isolated during concurrent dispatch", async () => {
	let releaseFirst: (() => void) | undefined;
	const firstGate = new Promise<void>((resolveFirst) => {
		releaseFirst = resolveFirst;
	});
	let markFirstStarted: (() => void) | undefined;
	const firstStarted = new Promise<void>((resolveStarted) => {
		markFirstStarted = resolveStarted;
	});
	const observed: boolean[] = [];
	const session = createSession({
		emit: () => void observed.push(isNestedPtcToolCall()),
		beforeToolCall: () => void observed.push(isNestedPtcToolCall()),
		afterToolCall: () => void observed.push(isNestedPtcToolCall()),
	});
	const executor = createToolExecutor({
		catalog: [
			createEntry({
				name: "first",
				async execute() {
					observed.push(isNestedPtcToolCall());
					markFirstStarted?.();
					await firstGate;
					return { content: [], details: {} };
				},
			}),
			createEntry({
				name: "second",
				async execute() {
					observed.push(isNestedPtcToolCall());
					return { content: [], details: {} };
				},
			}),
		],
		session,
	});

	const first = executor.dispatch({ name: "first", args: {} });
	await firstStarted;
	assert.equal(isNestedPtcToolCall(), false);
	await Promise.resolve().then(() => assert.equal(isNestedPtcToolCall(), false));
	const second = executor.dispatch({ name: "second", args: {} });
	await second;
	releaseFirst?.();
	await first;
	assert.equal(isNestedPtcToolCall(), false);
	assert.equal(observed.length > 0, true);
	assert.equal(observed.every(Boolean), true);
});

function createLeakGuardHarness(execute?: PiRuntimeTool["execute"]): {
	executor: ReturnType<typeof createToolExecutor>;
	directCall(toolCallId?: string): Promise<unknown>;
	getOtherHandlerCalls(): number;
} {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const definitions = new Map<string, object>();
	const registry = new Map<string, PiRuntimeTool>();
	let physical = ["read"];
	let actions: PiSharedRuntime = {
		getActiveTools: () => [...physical],
		setActiveTools: (names: string[]) => {
			physical = names.filter((name) => registry.has(name));
		},
		refreshTools: () => undefined,
	};
	let captureInstaller: PiRuntimeInstaller | undefined;
	let finalizers: PiRuntimeEventFinalizers | undefined;
	let otherHandlerCalls = 0;
	const readEntry = createEntry({ name: "read", ...(execute ? { execute } : {}) });
	registry.set("read", readEntry.executable);
	definitions.set("read", readEntry.definition as object);
	const ctx: ExtensionContext = {
		cwd: "/tmp",
		ui: { notify() {}, setStatus() {} },
		isProjectTrusted: () => true,
	};
	const pi: ExtensionAPI = {
		registerTool(definition) {
			const tool = definition as object & { name: string };
			definitions.set(tool.name, tool);
			registry.set(tool.name, tool as unknown as PiRuntimeTool);
		},
		registerCommand() {},
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler as (event: unknown, ctx: ExtensionContext) => unknown);
			handlers.set(event, list);
		},
		setActiveTools(names) {
			actions.setActiveTools(names);
		},
		getActiveTools: () => actions.getActiveTools(),
		getAllTools: () => [...definitions.keys()].map((name) => ({ name })),
		appendEntry() {},
		events: { emit() {} },
	};
	installPtc(pi, {
		installRuntimeCapture(installer) {
			captureInstaller = installer;
			return { compatible: true, teardown() {} };
		},
	});
	pi.on("tool_call", () => {
		otherHandlerCalls += 1;
	});
	const emitToolCall = async (event: unknown): Promise<unknown> => {
		let aggregate: unknown;
		for (const handler of handlers.get("tool_call") ?? []) {
			const result = await handler(event, ctx);
			if (result !== undefined) aggregate = result;
		}
		return finalizers?.finalizeToolCall([event], aggregate, ctx) ?? aggregate;
	};
	const session: CapturedPiSession = {
		version: SUPPORTED_PI_VERSION,
		extensionRunner: { createContext: () => ctx, emit: async () => undefined },
		sharedRuntime: {
			getActiveTools: () => actions.getActiveTools(),
			setActiveTools: (names) => actions.setActiveTools(names),
			refreshTools: () => actions.refreshTools(),
		},
		get toolRegistry() {
			return registry;
		},
		beforeToolCall: async (...args: unknown[]) => {
			const context = args[0] as HookContext;
			return emitToolCall({
				type: "tool_call",
				toolName: context.toolCall.name,
				toolCallId: context.toolCall.id,
				input: context.args,
			});
		},
		afterToolCall: async () => undefined,
		getToolDefinition: (name) => definitions.get(name),
		prepareToolArguments(name, rawArguments) {
			return createPiToolArgumentPreparer(registry)(name, rawArguments);
		},
		installRuntimeActions(replacements): PiRuntimeActionsInstallation {
			const original = actions;
			actions = replacements;
			return {
				original: {
					getActiveTools: original.getActiveTools,
					setActiveTools: original.setActiveTools,
					refreshTools: original.refreshTools,
					snapshotTools: () =>
						[...registry].map(([name, executable]) => ({
							name,
							executable,
							definition: definitions.get(name),
						})),
				},
				restore(activeNames) {
					if (activeNames) original.setActiveTools([...activeNames]);
					actions = original;
				},
			};
		},
		installRuntimeEventFinalizers(value): PiRuntimeEventFinalizersInstallation {
			finalizers = value;
			return {
				restore() {
					finalizers = undefined;
				},
			};
		},
	};
	for (const handler of handlers.get("session_start") ?? []) {
		handler({ type: "session_start", reason: "startup" }, ctx);
	}
	assert.ok(captureInstaller);
	captureInstaller.capturePiRuntime({ compatible: true, session });
	const executor = createToolExecutor({ catalog: [readEntry], session });
	return {
		executor,
		directCall: (toolCallId = "direct") =>
			emitToolCall({ type: "tool_call", toolName: "read", toolCallId, input: {} }),
		getOtherHandlerCalls: () => otherHandlerCalls,
	};
}

test("leak guard permits only the exact active nested call ID", async () => {
	let directCall: ((toolCallId?: string) => Promise<unknown>) | undefined;
	let exactResult: unknown;
	let differentResult: unknown;
	const harness = createLeakGuardHarness(async (toolCallId) => {
		assert.equal(isNestedPtcToolCall(toolCallId), true);
		assert.equal(isNestedPtcToolCall("different"), false);
		assert.ok(directCall);
		exactResult = await directCall(toolCallId);
		differentResult = await directCall("different");
		return { content: [], details: {} };
	});
	directCall = harness.directCall;

	const nested = await harness.executor.dispatch({ name: "read", args: {} });
	assert.equal(nested.isError, false);
	assert.equal(exactResult, undefined);
	assert.deepEqual(differentResult, { block: true, reason: LEAK_BLOCK_REASON });
	assert.equal(harness.getOtherHandlerCalls(), 3);
	assert.deepEqual(await harness.directCall(), { block: true, reason: LEAK_BLOCK_REASON });
	assert.equal(harness.getOtherHandlerCalls(), 4);
});

test("revoked nested marker blocks detached descendant hidden calls", async () => {
	let releaseDetached: (() => void) | undefined;
	const detachedGate = new Promise<void>((resolveDetached) => {
		releaseDetached = resolveDetached;
	});
	let directCall: ((toolCallId?: string) => Promise<unknown>) | undefined;
	let detachedMarker: boolean | undefined;
	let detachedResult: unknown;
	let detached: Promise<void> | undefined;
	const harness = createLeakGuardHarness(async (toolCallId) => {
		detached = detachedGate.then(async () => {
			detachedMarker = isNestedPtcToolCall(toolCallId);
			assert.ok(directCall);
			detachedResult = await directCall(toolCallId);
		});
		return { content: [], details: {} };
	});
	directCall = harness.directCall;

	const nested = await harness.executor.dispatch({ name: "read", args: {} });
	assert.equal(nested.isError, false);
	releaseDetached?.();
	await detached;
	assert.equal(detachedMarker, false);
	assert.deepEqual(detachedResult, { block: true, reason: LEAK_BLOCK_REASON });
	assert.equal(harness.getOtherHandlerCalls(), 2);
});

test("leak guard permits marked nested hidden calls but blocks direct hidden calls", async () => {
	const harness = createLeakGuardHarness();
	const nested = await harness.executor.dispatch({ name: "read", args: {} });
	assert.equal(nested.isError, false);
	assert.equal(harness.getOtherHandlerCalls(), 1);
	assert.deepEqual(await harness.directCall(), { block: true, reason: LEAK_BLOCK_REASON });
	assert.equal(harness.getOtherHandlerCalls(), 2);
});
