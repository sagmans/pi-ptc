import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Type } from "typebox";

import type { PiRuntimeTool } from "../src/pi-runtime.ts";
import { createToolExecutor } from "../src/tool-executor.ts";
import {
	asEvent,
	createEntry,
	createSession,
	type HookContext,
	isRecord,
	type RuntimeEvent,
	TOOL_NAME,
	ZERO_USAGE,
} from "./support/tool-executor-harness.ts";

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
			argumentTools: [nestedEntry],
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
