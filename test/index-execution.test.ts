import { strict as assert } from "node:assert";
import test from "node:test";

import { Type } from "typebox";

import { LEAK_BLOCK_REASON, TRANSPORT_NAME } from "../src/config.ts";
import type { PiRuntimeTool } from "../src/pi-runtime.ts";
import {
	CUSTOM_RUNTIME_TOOL_NAME,
	createFakePi,
	type FakePiHarness,
	INACTIVE_RUNTIME_TOOL_NAME,
	installHarness,
	parseOuterResult,
	startAndCapture,
} from "./support/index-harness.ts";

test("production install binds the active captured catalog with native hooks and dynamic SDK", async () => {
	const sequence: string[] = [];
	let nestedGuardResult: unknown = Symbol("not-called");
	let harness: FakePiHarness;
	const customExecutable: PiRuntimeTool = {
		parameters: Type.Object({ city: Type.String() }),
		executionMode: "parallel",
		async execute(_toolCallId, args) {
			sequence.push("execute");
			return {
				content: [{ type: "text", text: `before:${(args as { city: string }).city}` }],
				details: { source: "captured-wrapper" },
			};
		},
	};
	harness = createFakePi(
		["read", CUSTOM_RUNTIME_TOOL_NAME],
		["read", CUSTOM_RUNTIME_TOOL_NAME, INACTIVE_RUNTIME_TOOL_NAME],
		{
			async beforeToolCall(...args: unknown[]) {
				sequence.push("before");
				const context = args[0] as {
					toolCall: { id: string; name: string };
				};
				nestedGuardResult = await harness.emitToolCall({
					toolCallId: context.toolCall.id,
					toolName: context.toolCall.name,
				});
			},
			async afterToolCall(...args: unknown[]) {
				sequence.push("after");
				const context = args[0] as { args: { city: string } };
				return {
					content: [{ type: "text", text: `after:${context.args.city}` }],
					details: { source: "after-hook" },
				};
			},
		},
	);
	harness.registerRuntimeTool(CUSTOM_RUNTIME_TOOL_NAME, customExecutable, {
		name: CUSTOM_RUNTIME_TOOL_NAME,
		label: "Weather",
		description: "Read deterministic weather",
	});
	installHarness(harness);
	startAndCapture(harness);
	const tool = harness.tools.get(TRANSPORT_NAME);
	assert.ok(tool);

	const result = await tool.execute(
		"captured-custom",
		{
			code: `const value = await tools[${JSON.stringify(CUSTOM_RUNTIME_TOOL_NAME)}]({ city: "Paris" }); return { names: Object.keys(tools).sort(), inactive: typeof tools.${INACTIVE_RUNTIME_TOOL_NAME}, ptc: typeof tools.${TRANSPORT_NAME}, value };`,
			description: "run captured custom tool",
		},
		undefined,
		undefined,
		harness.ctx,
	);
	const outer = parseOuterResult(result);
	const value = outer.result as {
		names: string[];
		inactive: string;
		ptc: string;
		value: { text: string; details: { source: string } };
	};
	assert.deepEqual(sequence, ["before", "execute", "after"]);
	assert.equal(nestedGuardResult, undefined);
	assert.deepEqual(value.names, [CUSTOM_RUNTIME_TOOL_NAME, "read"]);
	assert.equal(value.inactive, "undefined");
	assert.equal(value.ptc, "undefined");
	assert.equal(value.value.text, "after:Paris");
	assert.deepEqual(value.value.details, { source: "after-hook" });

	const prompt = (await harness.emitBeforeAgentStart("prompt")) as { systemPrompt: string };
	assert.match(
		prompt.systemPrompt,
		/tools\.read arguments: \{ path: string; offset\?: number; limit\?: number \}/,
	);
	assert.equal(
		prompt.systemPrompt.includes(
			`tools[${JSON.stringify(CUSTOM_RUNTIME_TOOL_NAME)}] arguments: { city: string }`,
		),
		true,
	);
	assert.doesNotMatch(prompt.systemPrompt, /tools\.inactive_runtime/);
	assert.doesNotMatch(prompt.systemPrompt, /tools\.ptc arguments:/);
	assert.deepEqual(await harness.emitToolCall({ toolName: CUSTOM_RUNTIME_TOOL_NAME }), {
		block: true,
		reason: LEAK_BLOCK_REASON,
	});
});

test("custom direct calls are blocked only under code presentation", async () => {
	const harness = createFakePi([CUSTOM_RUNTIME_TOOL_NAME]);
	installHarness(harness);
	startAndCapture(harness);

	assert.deepEqual(await harness.emitToolCall({ toolName: CUSTOM_RUNTIME_TOOL_NAME }), {
		block: true,
		reason: LEAK_BLOCK_REASON,
	});
	await harness.commands.get("ptc")?.handler("both", harness.ctx);
	assert.equal(await harness.emitToolCall({ toolName: CUSTOM_RUNTIME_TOOL_NAME }), undefined);
	await harness.commands.get("ptc")?.handler("off", harness.ctx);
	assert.equal(await harness.emitToolCall({ toolName: CUSTOM_RUNTIME_TOOL_NAME }), undefined);
});
