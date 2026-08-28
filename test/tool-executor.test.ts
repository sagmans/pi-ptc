import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Type } from "typebox";

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
import type { DispatchKind } from "../src/scheduler.ts";
import type { ToolCatalogEntry } from "../src/tool-catalog.ts";
import {
	classifyToolDispatch,
	createToolExecutor,
	isNestedPtcToolCall,
	NESTED_PTC_TOOL_CALL_ID_PREFIX,
} from "../src/tool-executor.ts";

const TOOL_NAME = "demo";
const OTHER_TOOL_NAME = "other";
const OPERATION_ABORTED_MESSAGE = "Operation aborted";
const ZERO_USAGE = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

type RuntimeEvent = Record<string, unknown> & { type: string };
type HookContext = {
	assistantMessage: Record<string, unknown> & { content: unknown[] };
	toolCall: Record<string, unknown> & {
		type: "toolCall";
		id: string;
		name: string;
		arguments: unknown;
	};
	args: unknown;
	context: {
		systemPrompt: string;
		messages: unknown[];
		tools: Array<PiRuntimeTool & { name: string; label: string; description: string }>;
	};
	result?: Record<string, unknown>;
	isError?: boolean;
};

type SessionOptions = {
	emit?: (event: RuntimeEvent) => Promise<unknown> | unknown;
	beforeToolCall?: (context: HookContext, signal?: AbortSignal) => Promise<unknown> | unknown;
	afterToolCall?: (context: HookContext, signal?: AbortSignal) => Promise<unknown> | unknown;
};

type EntryOptions = {
	name?: string;
	parameters?: object;
	prepareArguments?: (args: unknown) => unknown;
	executionMode?: "parallel" | "sequential";
	execute?: PiRuntimeTool["execute"];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asEvent(value: unknown): RuntimeEvent {
	assert.equal(isRecord(value), true);
	assert.equal(typeof (value as Record<string, unknown>).type, "string");
	return value as RuntimeEvent;
}

function createSession(options: SessionOptions = {}): CapturedPiSession {
	return {
		version: SUPPORTED_PI_VERSION,
		extensionRunner: {
			createContext: () => ({ cwd: "/tmp" }),
			emit: async (event) => options.emit?.(asEvent(event)),
		},
		sharedRuntime: {
			getActiveTools: () => [],
			setActiveTools() {},
			refreshTools() {},
		},
		toolRegistry: new Map(),
		beforeToolCall: async (...args: unknown[]) =>
			options.beforeToolCall?.(args[0] as HookContext, args[1] as AbortSignal | undefined),
		afterToolCall: async (...args: unknown[]) =>
			options.afterToolCall?.(args[0] as HookContext, args[1] as AbortSignal | undefined),
		getToolDefinition: () => undefined,
		installRuntimeActions(): PiRuntimeActionsInstallation {
			throw new Error("not used by tool executor tests");
		},
		installRuntimeEventFinalizers(): PiRuntimeEventFinalizersInstallation {
			throw new Error("not used by tool executor tests");
		},
	};
}

function createEntry(options: EntryOptions = {}): ToolCatalogEntry {
	const executable: PiRuntimeTool = {
		parameters: options.parameters ?? Type.Object({}),
		...(options.prepareArguments ? { prepareArguments: options.prepareArguments } : {}),
		...(options.executionMode ? { executionMode: options.executionMode } : {}),
		execute:
			options.execute ?? (async () => ({ content: [{ type: "text", text: "ok" }], details: {} })),
	};
	const name = options.name ?? TOOL_NAME;
	return { name, executable, definition: { name } };
}

function resultText(result: { content?: unknown }): string | undefined {
	if (!Array.isArray(result.content)) return undefined;
	const first = result.content[0];
	return isRecord(first) && typeof first.text === "string" ? first.text : undefined;
}

function immediate(): Promise<void> {
	return new Promise((resolveImmediate) => setImmediate(resolveImmediate));
}

async function loadNativeValidation(): Promise<{
	validateToolArguments(
		tool: PiRuntimeTool & { name: string },
		toolCall: HookContext["toolCall"],
	): unknown;
}> {
	const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const validationPath = resolve(
		dirname(codingAgentEntry),
		"../node_modules/@earendil-works/pi-ai/dist/utils/validation.js",
	);
	return (await import(pathToFileURL(validationPath).href)) as {
		validateToolArguments(
			tool: PiRuntimeTool & { name: string },
			toolCall: HookContext["toolCall"],
		): unknown;
	};
}

test("dispatch mirrors native raw/prepared argument flow and lifecycle ordering", async () => {
	const sequence: string[] = [];
	const events: RuntimeEvent[] = [];
	const rawArgs = { count: "2", nullable: null };
	let executionArgs: Record<string, unknown> | undefined;
	let beforeAssistantMessage: HookContext["assistantMessage"] | undefined;
	let beforeAgentContext: HookContext["context"] | undefined;
	const entry = createEntry({
		parameters: Type.Object({
			count: Type.Number(),
			nullable: Type.Optional(Type.String()),
		}),
		prepareArguments(args) {
			sequence.push("prepare");
			assert.equal(isNestedPtcToolCall(), true);
			return { ...(args as Record<string, unknown>) };
		},
		async execute(toolCallId, args, _signal, onUpdate) {
			sequence.push("execute");
			assert.equal(isNestedPtcToolCall(), true);
			assert.match(toolCallId, new RegExp(`^${NESTED_PTC_TOOL_CALL_ID_PREFIX}`));
			executionArgs = args as Record<string, unknown>;
			assert.deepEqual(executionArgs, { count: 3 });
			onUpdate?.({ content: [{ type: "text", text: "partial" }], details: { step: 1 } });
			return { content: [{ type: "text", text: "done" }], details: { phase: "execute" } };
		},
	});
	const session = createSession({
		emit(event) {
			assert.equal(isNestedPtcToolCall(), true);
			events.push(event);
			if (event.type === "tool_execution_start") sequence.push("start");
			if (event.type === "tool_execution_update") sequence.push("update");
			if (event.type === "tool_execution_end") sequence.push("end");
		},
		beforeToolCall(context) {
			sequence.push("before");
			assert.equal(isNestedPtcToolCall(), true);
			beforeAssistantMessage = context.assistantMessage;
			beforeAgentContext = context.context;
			assert.equal(context.toolCall.arguments, rawArgs);
			assert.equal(context.assistantMessage.content[0], context.toolCall);
			assert.equal(context.context.messages[0], context.assistantMessage);
			assert.equal(context.context.tools[0]?.name, TOOL_NAME);
			assert.equal(context.context.tools[0]?.label, TOOL_NAME);
			assert.equal(context.context.tools[0]?.description, "");
			assert.equal(context.context.tools[0]?.parameters, entry.executable.parameters);
			assert.equal(context.context.systemPrompt, "");
			assert.deepEqual(context.args, { count: 2 });
			(context.args as Record<string, unknown>).count = 3;
		},
		afterToolCall(context) {
			sequence.push("after");
			assert.equal(isNestedPtcToolCall(), true);
			assert.equal(context.assistantMessage, beforeAssistantMessage);
			assert.equal(context.context, beforeAgentContext);
			assert.equal(context.args, executionArgs);
			assert.deepEqual(context.result, {
				content: [{ type: "text", text: "done" }],
				details: { phase: "execute" },
			});
			return { details: { phase: "after" } };
		},
	});
	const executor = createToolExecutor({ catalog: [entry], session });

	assert.equal(isNestedPtcToolCall(), false);
	const outcome = await executor.dispatch({
		name: TOOL_NAME,
		args: rawArgs,
		onUpdate(partialResult) {
			sequence.push("caller-update");
			assert.equal(isNestedPtcToolCall(), true);
			assert.deepEqual(partialResult, {
				content: [{ type: "text", text: "partial" }],
				details: { step: 1 },
			});
		},
	});
	assert.equal(isNestedPtcToolCall(), false);

	assert.deepEqual(sequence, [
		"start",
		"prepare",
		"before",
		"execute",
		"caller-update",
		"update",
		"after",
		"end",
	]);
	assert.equal(events[0]?.args, rawArgs);
	assert.equal(events[1]?.args, rawArgs);
	assert.equal(events[2]?.result, outcome.result);
	assert.equal(outcome.rawArgs, rawArgs);
	assert.equal(outcome.executionArgs, executionArgs);
	assert.equal(outcome.isError, false);
	assert.deepEqual(outcome.result.details, { phase: "after" });
});

test("validation clones prepared args, applies Pi coercion, and preserves Pi diagnostics", async () => {
	const schema = {
		type: "object",
		properties: {
			count: { type: "integer" },
			enabled: { type: "boolean" },
			note: { type: "string" },
		},
		required: ["count", "enabled"],
		additionalProperties: false,
	};
	const prepared = { count: "3", enabled: "false", note: null };
	let seenArgs: unknown;
	const entry = createEntry({
		parameters: schema,
		prepareArguments: () => prepared,
		async execute(_id, args) {
			seenArgs = args;
			return { content: [], details: {} };
		},
	});
	const executor = createToolExecutor({ catalog: [entry], session: createSession() });
	const success = await executor.dispatch({ name: TOOL_NAME, args: { ignored: true } });

	assert.equal(success.isError, false);
	assert.deepEqual(seenArgs, { count: 3, enabled: false });
	assert.deepEqual(prepared, { count: "3", enabled: "false", note: null });

	const invalid = createToolExecutor({
		catalog: [createEntry({ parameters: schema })],
		session: createSession(),
	});
	const failure = await invalid.dispatch({
		name: TOOL_NAME,
		args: { count: "nope", enabled: true },
	});
	assert.equal(failure.isError, true);
	assert.equal(
		resultText(failure.result),
		'Validation failed for tool "demo":\n  - count: must be integer\n\nReceived arguments:\n{\n  "count": "nope",\n  "enabled": true\n}',
	);
	assert.equal(failure.executionArgs, undefined);
});

test("nullable object union validation matches Pi 0.84.3", async (t) => {
	const nativeValidation = await loadNativeValidation();
	const schema = {
		type: ["object", "null"],
		properties: {
			count: { type: "integer" },
			enabled: { type: "boolean" },
			note: { type: "string" },
		},
		required: ["count", "enabled"],
		additionalProperties: false,
	};
	const nativeTool = { name: TOOL_NAME, ...createEntry({ parameters: schema }).executable };
	const nativeToolCall = (args: unknown): HookContext["toolCall"] => ({
		type: "toolCall",
		id: "native-validation",
		name: TOOL_NAME,
		arguments: args,
	});
	const dispatchNested = async (args: unknown) => {
		let executedArgs: unknown;
		const outcome = await createToolExecutor({
			catalog: [
				createEntry({
					parameters: schema,
					execute: async (_id, validatedArgs) => {
						executedArgs = validatedArgs;
						return { content: [], details: {} };
					},
				}),
			],
			session: createSession(),
		}).dispatch({ name: TOOL_NAME, args });
		return { outcome, executedArgs };
	};

	await t.test("accepts null branch", async () => {
		const native = nativeValidation.validateToolArguments(nativeTool, nativeToolCall(null));
		const nested = await dispatchNested(null);
		assert.equal(native, null);
		assert.equal(nested.executedArgs, native);
		assert.equal(nested.outcome.executionArgs, native);
		assert.equal(nested.outcome.isError, false);
	});

	await t.test("accepts object branch with matching conversion and coercion", async () => {
		const args = { count: "3", enabled: "false", note: null };
		const native = nativeValidation.validateToolArguments(nativeTool, nativeToolCall(args));
		const nested = await dispatchNested(args);
		assert.deepEqual(native, { count: 3, enabled: false });
		assert.deepEqual(nested.executedArgs, native);
		assert.deepEqual(nested.outcome.executionArgs, native);
		assert.equal(nested.outcome.isError, false);
	});

	await t.test("reports the same diagnostics", async () => {
		const args = { count: "nope", enabled: true };
		let nativeMessage: string | undefined;
		try {
			nativeValidation.validateToolArguments(nativeTool, nativeToolCall(args));
			assert.fail("native validation should fail");
		} catch (error) {
			nativeMessage = error instanceof Error ? error.message : String(error);
		}
		const nested = await dispatchNested(args);
		assert.equal(nested.outcome.isError, true);
		assert.equal(resultText(nested.outcome.result), nativeMessage);
	});
});

test("pre-execution failures emit final errors without execute or after hooks", async (t) => {
	await t.test("missing tool", async () => {
		const events: RuntimeEvent[] = [];
		const outcome = await createToolExecutor({
			catalog: [],
			session: createSession({ emit: (event) => events.push(event) }),
		}).dispatch({ name: "absent", args: {} });
		assert.equal(resultText(outcome.result), "Tool absent not found");
		assert.equal(outcome.isError, true);
		assert.deepEqual(
			events.map((event) => event.type),
			["tool_execution_start", "tool_execution_end"],
		);
	});

	await t.test("prepare throw", async () => {
		let executes = 0;
		let afters = 0;
		const entry = createEntry({
			prepareArguments() {
				throw new Error("prepare failed");
			},
			execute: async () => {
				executes += 1;
				return { content: [], details: {} };
			},
		});
		const outcome = await createToolExecutor({
			catalog: [entry],
			session: createSession({
				afterToolCall() {
					afters += 1;
				},
			}),
		}).dispatch({ name: TOOL_NAME, args: {} });
		assert.equal(resultText(outcome.result), "prepare failed");
		assert.equal(executes, 0);
		assert.equal(afters, 0);
	});

	await t.test("before hook throw", async () => {
		let executes = 0;
		let afters = 0;
		const entry = createEntry({
			execute: async () => {
				executes += 1;
				return { content: [], details: {} };
			},
		});
		const outcome = await createToolExecutor({
			catalog: [entry],
			session: createSession({
				beforeToolCall(context) {
					(context.args as Record<string, unknown>).mutated = true;
					throw new Error("before failed");
				},
				afterToolCall() {
					afters += 1;
				},
			}),
		}).dispatch({ name: TOOL_NAME, args: {} });
		assert.equal(resultText(outcome.result), "before failed");
		assert.deepEqual(outcome.executionArgs, { mutated: true });
		assert.equal(executes, 0);
		assert.equal(afters, 0);
	});

	await t.test("before hook block with terminate", async () => {
		let executes = 0;
		let afters = 0;
		const outcome = await createToolExecutor({
			catalog: [
				createEntry({
					execute: async () => {
						executes += 1;
						return { content: [], details: {} };
					},
				}),
			],
			session: createSession({
				beforeToolCall: () => ({ block: true, reason: "policy block", terminate: true }),
				afterToolCall() {
					afters += 1;
				},
			}),
		}).dispatch({ name: TOOL_NAME, args: {} });
		assert.equal(resultText(outcome.result), "policy block");
		assert.equal(outcome.result.terminate, true);
		assert.equal(executes, 0);
		assert.equal(afters, 0);
	});

	await t.test("pre-execute abort", async () => {
		const controller = new AbortController();
		controller.abort();
		let befores = 0;
		let executes = 0;
		let afters = 0;
		const outcome = await createToolExecutor({
			catalog: [
				createEntry({
					execute: async () => {
						executes += 1;
						return { content: [], details: {} };
					},
				}),
			],
			session: createSession({
				beforeToolCall() {
					befores += 1;
				},
				afterToolCall() {
					afters += 1;
				},
			}),
		}).dispatch({ name: TOOL_NAME, args: {}, signal: controller.signal });
		assert.equal(resultText(outcome.result), OPERATION_ABORTED_MESSAGE);
		assert.equal(befores, 1);
		assert.equal(executes, 0);
		assert.equal(afters, 0);
	});
});

test("executable throws still run after hook and accept its patch", async () => {
	let afterContext: HookContext | undefined;
	const entry = createEntry({
		async execute() {
			throw new Error("execute failed");
		},
	});
	const outcome = await createToolExecutor({
		catalog: [entry],
		session: createSession({
			afterToolCall(context) {
				afterContext = context;
				return {
					content: [{ type: "text", text: "recovered" }],
					details: { recovered: true },
					isError: false,
				};
			},
		}),
	}).dispatch({ name: TOOL_NAME, args: {} });

	assert.equal(afterContext?.isError, true);
	assert.equal(resultText(afterContext?.result ?? {}), "execute failed");
	assert.equal(resultText(outcome.result), "recovered");
	assert.deepEqual(outcome.result.details, { recovered: true });
	assert.equal(outcome.isError, false);
});

test("after hook patches only native fields with nullish fallback", async () => {
	const additions = ["alpha"];
	const usage = { ...ZERO_USAGE, totalTokens: 7 };
	const entry = createEntry({
		async execute() {
			return {
				content: [{ type: "text", text: "before" }],
				details: { keep: true },
				usage,
				terminate: false,
				addedToolNames: additions,
				custom: "preserved",
			};
		},
	});
	const outcome = await createToolExecutor({
		catalog: [entry],
		session: createSession({
			afterToolCall: () => ({
				content: [{ type: "text", text: "after" }],
				details: undefined,
				usage: null,
				terminate: true,
				isError: true,
				addedToolNames: ["ignored"],
				custom: "ignored",
			}),
		}),
	}).dispatch({ name: TOOL_NAME, args: {} });

	assert.equal(resultText(outcome.result), "after");
	assert.deepEqual(outcome.result.details, { keep: true });
	assert.equal(outcome.result.usage, usage);
	assert.equal(outcome.result.terminate, true);
	assert.equal(outcome.result.addedToolNames, additions);
	assert.equal(outcome.result.custom, "preserved");
	assert.equal(outcome.isError, true);
});

test("thrown after hook replaces executed result with native error shape", async () => {
	const entry = createEntry({
		async execute() {
			return {
				content: [{ type: "text", text: "discarded" }],
				details: { discarded: true },
				addedToolNames: ["discarded"],
			};
		},
	});
	const outcome = await createToolExecutor({
		catalog: [entry],
		session: createSession({
			afterToolCall() {
				throw new Error("after failed");
			},
		}),
	}).dispatch({ name: TOOL_NAME, args: {} });

	assert.deepEqual(outcome.result, {
		content: [{ type: "text", text: "after failed" }],
		details: {},
	});
	assert.equal(outcome.isError, true);
});

test("dispatch drains asynchronous updates and ignores updates after execute settles", async () => {
	let releaseUpdate: (() => void) | undefined;
	const updateGate = new Promise<void>((resolveUpdate) => {
		releaseUpdate = resolveUpdate;
	});
	const emittedUpdates: unknown[] = [];
	const callerUpdates: unknown[] = [];
	let retainedUpdate: ((partial: unknown) => void) | undefined;
	let dispatchSettled = false;
	const entry = createEntry({
		async execute(_id, _args, _signal, onUpdate) {
			retainedUpdate = onUpdate;
			onUpdate?.({ content: [], details: { accepted: true } });
			return { content: [], details: { done: true } };
		},
	});
	const executor = createToolExecutor({
		catalog: [entry],
		session: createSession({
			emit(event) {
				if (event.type !== "tool_execution_update") return undefined;
				emittedUpdates.push(event.partialResult);
				return updateGate;
			},
		}),
	});
	const dispatch = executor
		.dispatch({
			name: TOOL_NAME,
			args: {},
			onUpdate: (partial) => void callerUpdates.push(partial),
		})
		.finally(() => {
			dispatchSettled = true;
		});

	await immediate();
	assert.equal(dispatchSettled, false);
	assert.ok(retainedUpdate);
	retainedUpdate({ content: [], details: { accepted: false } });
	assert.equal(emittedUpdates.length, 1);
	assert.equal(callerUpdates.length, 1);
	releaseUpdate?.();
	await dispatch;
	assert.equal(dispatchSettled, true);
	assert.equal(emittedUpdates.length, 1);
	assert.equal(callerUpdates.length, 1);
});

test("update delivery failures still run after hook and emit one final end", async (t) => {
	const runFailure = async (options: {
		executeError?: Error;
		onUpdate: (partial: unknown) => Promise<void> | void;
		expectedMessage: string;
	}) => {
		let afters = 0;
		const endEvents: RuntimeEvent[] = [];
		const outcome = await createToolExecutor({
			catalog: [
				createEntry({
					async execute(_id, _args, _signal, onUpdate) {
						onUpdate?.({ content: [], details: { accepted: true } });
						if (options.executeError) throw options.executeError;
						return { content: [], details: { executed: true } };
					},
				}),
			],
			session: createSession({
				emit(event) {
					if (event.type === "tool_execution_end") endEvents.push(event);
				},
				afterToolCall(context) {
					afters += 1;
					assert.equal(context.isError, true);
					assert.equal(resultText(context.result ?? {}), options.expectedMessage);
				},
			}),
		}).dispatch({ name: TOOL_NAME, args: {}, onUpdate: options.onUpdate });
		assert.equal(afters, 1);
		assert.equal(endEvents.length, 1);
		assert.equal(endEvents[0]?.result, outcome.result);
		assert.equal(endEvents[0]?.isError, true);
		assert.equal(outcome.isError, true);
		assert.equal(resultText(outcome.result), options.expectedMessage);
	};

	await t.test("synchronous callback throw", async () => {
		await runFailure({
			onUpdate() {
				throw new Error("sync update failed");
			},
			expectedMessage: "sync update failed",
		});
	});

	await t.test("asynchronous callback rejection", async () => {
		await runFailure({
			async onUpdate() {
				await immediate();
				throw new Error("async update failed");
			},
			expectedMessage: "async update failed",
		});
	});

	await t.test("execute error remains primary", async () => {
		await runFailure({
			executeError: new Error("execute failed first"),
			onUpdate() {
				throw new Error("update also failed");
			},
			expectedMessage: "execute failed first",
		});
	});
});

test("nested call IDs are unique and use the named prefix", async () => {
	const executor = createToolExecutor({ catalog: [createEntry()], session: createSession() });
	const [first, second] = await Promise.all([
		executor.dispatch({ name: TOOL_NAME, args: {} }),
		executor.dispatch({ name: TOOL_NAME, args: {} }),
	]);
	assert.notEqual(first.toolCallId, second.toolCallId);
	assert.match(first.toolCallId, new RegExp(`^${NESTED_PTC_TOOL_CALL_ID_PREFIX}`));
	assert.match(second.toolCallId, new RegExp(`^${NESTED_PTC_TOOL_CALL_ID_PREFIX}`));
});

test("activation callback receives only additions retained by finalization", async () => {
	const retainedNames = ["alpha", "beta"];
	const activated: Array<readonly string[]> = [];
	const entries = [
		createEntry({
			name: "retained",
			execute: async () => ({ content: [], details: {}, addedToolNames: retainedNames }),
		}),
		createEntry({
			name: "empty",
			execute: async () => ({ content: [], details: {}, addedToolNames: [] }),
		}),
		createEntry({
			name: "discarded",
			execute: async () => ({ content: [], details: {}, addedToolNames: ["discarded"] }),
		}),
	];
	const executor = createToolExecutor({
		catalog: entries,
		session: createSession({
			afterToolCall(context) {
				if (context.toolCall.name === "discarded") throw new Error("postprocessor failed");
			},
		}),
		activateTools: (names) => void activated.push(names),
	});

	await executor.dispatch({ name: "retained", args: {} });
	await executor.dispatch({ name: "empty", args: {} });
	await executor.dispatch({ name: "discarded", args: {} });
	assert.equal(activated.length, 1);
	assert.equal(activated[0], retainedNames);
});

test("executor indexes a fixed catalog snapshot", async () => {
	const catalog = [createEntry()];
	const executor = createToolExecutor({ catalog, session: createSession() });
	catalog.push(createEntry({ name: OTHER_TOOL_NAME }));

	const absent = await executor.dispatch({ name: OTHER_TOOL_NAME, args: {} });
	assert.equal(absent.isError, true);
	assert.equal(resultText(absent.result), `Tool ${OTHER_TOOL_NAME} not found`);
	const nextExecutor = createToolExecutor({ catalog, session: createSession() });
	const present = await nextExecutor.dispatch({ name: OTHER_TOOL_NAME, args: {} });
	assert.equal(present.isError, false);
});

test("dispatch classification honors execution mode before known-core fallback", () => {
	const cases: Array<{ entry: ToolCatalogEntry; expected: DispatchKind }> = [
		{ entry: createEntry({ name: "foreign", executionMode: "sequential" }), expected: "exclusive" },
		{ entry: createEntry({ name: "bash", executionMode: "parallel" }), expected: "parallel" },
		{ entry: createEntry({ name: "bash" }), expected: "exclusive" },
		{ entry: createEntry({ name: "edit" }), expected: "exclusive" },
		{ entry: createEntry({ name: "write" }), expected: "exclusive" },
		{ entry: createEntry({ name: "read" }), expected: "parallel" },
		{ entry: createEntry({ name: "foreign" }), expected: "parallel" },
	];
	for (const { entry, expected } of cases) {
		assert.equal(classifyToolDispatch(entry), expected, entry.name);
	}
});

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
		resolvePaths: () => ({ projectFile: "/tmp/ptc-project.json", userFile: "/tmp/ptc-user.json" }),
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

test("observable pipeline matches Pi 0.84.3 agent-core characterization", async () => {
	const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const agentLoopPath = resolve(
		dirname(codingAgentEntry),
		"../node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js",
	);
	const nativeModule = (await import(pathToFileURL(agentLoopPath).href)) as {
		runAgentLoop(
			prompts: unknown[],
			context: Record<string, unknown>,
			config: Record<string, unknown>,
			emit: (event: unknown) => Promise<void>,
			signal: AbortSignal | undefined,
			streamFn: (...args: unknown[]) => Promise<unknown>,
		): Promise<unknown[]>;
	};
	const nativeEvents: RuntimeEvent[] = [];
	const nestedEvents: RuntimeEvent[] = [];
	const nativeExecutedArgs: unknown[] = [];
	const nestedExecutedArgs: unknown[] = [];
	const schema = Type.Object({ count: Type.Number() });
	const makeTool = (seen: unknown[]): PiRuntimeTool => ({
		parameters: schema,
		prepareArguments: (args) => ({ ...(args as Record<string, unknown>) }),
		async execute(_id, args, _signal, onUpdate) {
			seen.push(structuredClone(args));
			onUpdate?.({ content: [], details: { partial: true } });
			return { content: [{ type: "text", text: "done" }], details: { executed: true } };
		},
	});
	const nativeTool = {
		name: TOOL_NAME,
		label: TOOL_NAME,
		description: TOOL_NAME,
		...makeTool(nativeExecutedArgs),
	};
	const rawNativeArgs = { count: "4" };
	const rawNestedArgs = { count: "4" };
	const nativeToolCall = {
		type: "toolCall",
		id: "native-call",
		name: TOOL_NAME,
		arguments: rawNativeArgs,
	};
	const assistant = (content: unknown[], stopReason: "toolUse" | "stop") => ({
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "test",
		usage: ZERO_USAGE,
		stopReason,
		timestamp: Date.now(),
	});
	const nativeResponses = [assistant([nativeToolCall], "toolUse"), assistant([], "stop")];
	let responseIndex = 0;
	const streamFn = async () => {
		const message = nativeResponses[responseIndex++];
		assert.ok(message);
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "done", reason: message.stopReason, message };
			},
			result: async () => message,
		};
	};
	const nativeMessages = await nativeModule.runAgentLoop(
		[],
		{ systemPrompt: "", messages: [], tools: [nativeTool] },
		{
			model: { provider: "test", id: "test" },
			convertToLlm: async () => [],
			beforeToolCall: async (context: HookContext) => {
				(context.args as Record<string, number>).count += 1;
			},
			afterToolCall: async () => ({ details: { finalized: true } }),
		},
		async (event) => {
			const parsed = asEvent(event);
			if (parsed.type.startsWith("tool_execution_")) nativeEvents.push(parsed);
		},
		undefined,
		streamFn,
	);
	const nestedEntry = createEntry({
		parameters: schema,
		prepareArguments: (args) => ({ ...(args as Record<string, unknown>) }),
		execute: makeTool(nestedExecutedArgs).execute,
	});
	const nestedOutcome = await createToolExecutor({
		catalog: [nestedEntry],
		session: createSession({
			emit(event) {
				if (event.type.startsWith("tool_execution_")) nestedEvents.push(event);
			},
			beforeToolCall(context) {
				(context.args as Record<string, number>).count += 1;
			},
			afterToolCall: async () => ({ details: { finalized: true } }),
		}),
	}).dispatch({ name: TOOL_NAME, args: rawNestedArgs });
	const nativeToolResult = nativeMessages.find(
		(message) => isRecord(message) && message.role === "toolResult",
	) as Record<string, unknown> | undefined;

	assert.ok(nativeToolResult);
	assert.deepEqual(nativeExecutedArgs, nestedExecutedArgs);
	assert.deepEqual(
		nativeEvents.map((event) => event.type),
		nestedEvents.map((event) => event.type),
	);
	assert.deepEqual(nativeEvents[0]?.args, nestedEvents[0]?.args);
	assert.deepEqual(nativeEvents[1]?.args, nestedEvents[1]?.args);
	assert.deepEqual(nativeToolResult.content, nestedOutcome.result.content);
	assert.deepEqual(nativeToolResult.details, nestedOutcome.result.details);
	assert.equal(nativeToolResult.isError, nestedOutcome.isError);
});
