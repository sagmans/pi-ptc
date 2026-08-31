import { strict as assert } from "node:assert";
import test from "node:test";

import { Type } from "typebox";

import {
	createToolExecutor,
	isNestedPtcToolCall,
	NESTED_PTC_TOOL_CALL_ID_PREFIX,
} from "../src/tool-executor.ts";
import {
	createEntry,
	createSession,
	type HookContext,
	loadNativeValidation,
	type RuntimeEvent,
	resultText,
	TOOL_NAME,
} from "./support/tool-executor-harness.ts";

const NATIVE_ARGUMENT_DIAGNOSTIC_SEPARATOR = "\n\nReceived arguments:";

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
		argumentTools: [entry],
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
	const executor = createToolExecutor({
		catalog: [entry],
		session: createSession({ argumentTools: [entry] }),
	});
	const success = await executor.dispatch({ name: TOOL_NAME, args: { ignored: true } });

	assert.equal(success.isError, false);
	assert.deepEqual(seenArgs, { count: 3, enabled: false });
	assert.deepEqual(prepared, { count: "3", enabled: "false", note: null });

	const invalidEntry = createEntry({ parameters: schema });
	const invalid = createToolExecutor({
		catalog: [invalidEntry],
		session: createSession({ argumentTools: [invalidEntry] }),
	});
	const failure = await invalid.dispatch({
		name: TOOL_NAME,
		args: { count: "nope", enabled: true },
	});
	assert.equal(failure.isError, true);
	const failureText = resultText(failure.result);
	assert.equal(failureText, 'Validation failed for tool "demo":\n  - count: must be integer');
	assert.doesNotMatch(failureText ?? "", /nope|enabled/);
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
		const entry = createEntry({
			parameters: schema,
			execute: async (_id, validatedArgs) => {
				executedArgs = validatedArgs;
				return { content: [], details: {} };
			},
		});
		const outcome = await createToolExecutor({
			catalog: [entry],
			session: createSession({ argumentTools: [entry] }),
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
		assert.equal(
			resultText(nested.outcome.result),
			nativeMessage?.split(NATIVE_ARGUMENT_DIAGNOSTIC_SEPARATOR)[0],
		);
	});
});
