import { strict as assert } from "node:assert";
import test from "node:test";
import { createToolExecutor } from "../src/tool-executor.ts";
import {
	createEntry,
	createSession,
	type HookContext,
	immediate,
	OPERATION_ABORTED_MESSAGE,
	type RuntimeEvent,
	resultText,
	TOOL_NAME,
	ZERO_USAGE,
} from "./support/tool-executor-harness.ts";

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
