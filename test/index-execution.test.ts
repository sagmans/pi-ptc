import { strict as assert } from "node:assert";
import test from "node:test";

import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { LEAK_BLOCK_REASON, TRANSPORT_NAME } from "../src/config.ts";
import type { PiRuntimeTool } from "../src/pi-runtime.ts";
import {
	CUSTOM_RUNTIME_TOOL_NAME,
	createFakePi,
	createRealAdapterHarness,
	type FakePiHarness,
	INACTIVE_RUNTIME_TOOL_NAME,
	installHarness,
	parseOuterResult,
	type RealAdapterHarness,
	renderToolResult,
	startAndCapture,
	VISUAL_RUNTIME_TOOL_NAME,
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
	assert.match(prompt.systemPrompt, /await tools\.read\(\{ path, offset\?, limit\? \}\)/);
	assert.equal(
		prompt.systemPrompt.includes(
			`await tools[${JSON.stringify(CUSTOM_RUNTIME_TOOL_NAME)}]({ city: string })`,
		),
		true,
	);
	assert.doesNotMatch(prompt.systemPrompt, /tools\.inactive_runtime/);
	assert.doesNotMatch(prompt.systemPrompt, /await tools\.ptc\(/);
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

test("each production execution keeps one catalog snapshot until the next run", async () => {
	let harness: FakePiHarness;
	const lateExecutable: PiRuntimeTool = {
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "late" }] };
		},
	};
	const mutatorExecutable: PiRuntimeTool = {
		parameters: Type.Object({}),
		async execute() {
			harness.registerRuntimeTool("late", lateExecutable, { name: "late" });
			harness.pi.setActiveTools(["mutator", "late"]);
			assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);
			return { content: [{ type: "text", text: "mutated" }] };
		},
	};
	harness = createFakePi(["mutator", "old"]);
	harness.registerRuntimeTool("mutator", mutatorExecutable, { name: "mutator" });
	harness.registerRuntimeTool("old", {
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "old" }] };
		},
	});
	installHarness(harness);
	startAndCapture(harness);
	const tool = harness.tools.get(TRANSPORT_NAME);
	assert.ok(tool);

	const first = parseOuterResult(
		await tool.execute(
			"snapshot-first",
			{
				code: "await tools.mutator({}); return { late: typeof tools.late, old: typeof tools.old };",
				description: "mutate catalog during run",
			},
			undefined,
			undefined,
			harness.ctx,
		),
	).result;
	assert.deepEqual(first, { late: "undefined", old: "function" });
	const second = parseOuterResult(
		await tool.execute(
			"snapshot-second",
			{
				code: "return { late: typeof tools.late, old: typeof tools.old };",
				description: "read next catalog snapshot",
			},
			undefined,
			undefined,
			harness.ctx,
		),
	).result;
	assert.deepEqual(second, { late: "function", old: "undefined" });
});

test("production keeps pre-refresh real-adapter bindings fixed until the next run", async () => {
	let harness: RealAdapterHarness;
	let oldExecutions = 0;
	const oldExecutable: PiRuntimeTool = {
		parameters: Type.Object({}),
		async execute() {
			oldExecutions += 1;
			return { content: [{ type: "text", text: "old-v1" }] };
		},
	};
	const lateExecutable: PiRuntimeTool = {
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "late-v1" }] };
		},
	};
	const mutatorExecutable: PiRuntimeTool = {
		parameters: Type.Object({}),
		async execute() {
			harness.registerRuntimeTool("late", lateExecutable);
			harness.setActiveTools(["mutator", "late", TRANSPORT_NAME]);
			return { content: [{ type: "text", text: "mutated" }] };
		},
	};
	harness = createRealAdapterHarness(
		["mutator", "old"],
		[
			["mutator", mutatorExecutable, { name: "mutator" }],
			["old", oldExecutable, { name: "old" }],
		],
	);

	try {
		await harness.start();
		const tool = harness.tools.get(TRANSPORT_NAME);
		assert.ok(tool);
		const first = parseOuterResult(
			await tool.execute(
				"real-refresh-first",
				{
					code: "await tools.mutator({}); const old = await tools.old({}); return { late: typeof tools.late, old: old.text };",
					description: "refresh real adapter during run",
				},
				undefined,
				undefined,
				harness.ctx,
			),
		).result;
		assert.deepEqual(first, { late: "undefined", old: "old-v1" });
		assert.equal(oldExecutions, 1);
		assert.deepEqual(harness.notifications, []);
		assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);

		const second = parseOuterResult(
			await tool.execute(
				"real-refresh-second",
				{
					code: "return { late: typeof tools.late, old: typeof tools.old };",
					description: "read refreshed real adapter catalog",
				},
				undefined,
				undefined,
				harness.ctx,
			),
		).result;
		assert.deepEqual(second, { late: "function", old: "undefined" });
	} finally {
		harness.shutdown();
	}
});

test("addedToolNames updates logical state without exposing physical tools under code", async () => {
	const harness = createFakePi(["activator"], ["activator", "dormant"]);
	harness.registerRuntimeTool("activator", {
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: "activated" }],
				addedToolNames: ["dormant", "dormant", "missing", TRANSPORT_NAME],
			};
		},
	});
	installHarness(harness);
	startAndCapture(harness);
	const tool = harness.tools.get(TRANSPORT_NAME);
	assert.ok(tool);

	await tool.execute(
		"activate-added",
		{ code: "return await tools.activator({});", description: "activate added tools" },
		undefined,
		undefined,
		harness.ctx,
	);

	assert.deepEqual(harness.pi.getActiveTools(), ["activator", "dormant", TRANSPORT_NAME]);
	assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);
});

test("execution renderers remain fixed across mutation and concurrent production runs", async () => {
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let markFirstStarted!: () => void;
	const firstStarted = new Promise<void>((resolve) => {
		markFirstStarted = resolve;
	});
	const firstExecutable: PiRuntimeTool = {
		parameters: Type.Object({}),
		async execute() {
			markFirstStarted();
			await firstGate;
			return { content: [{ type: "text", text: "first result" }] };
		},
	};
	const secondExecutable: PiRuntimeTool = {
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "second result" }] };
		},
	};
	const definition = (marker: string) => ({
		name: VISUAL_RUNTIME_TOOL_NAME,
		renderCall: () => new Text(marker, 0, 0),
	});
	const harness = createFakePi([VISUAL_RUNTIME_TOOL_NAME]);
	harness.registerRuntimeTool(
		VISUAL_RUNTIME_TOOL_NAME,
		firstExecutable,
		definition("first renderer"),
	);
	installHarness(harness);
	startAndCapture(harness);
	const tool = harness.tools.get(TRANSPORT_NAME);
	assert.ok(tool);
	const execute = (toolCallId: string) =>
		tool.execute(
			toolCallId,
			{
				code: `return await tools.${VISUAL_RUNTIME_TOOL_NAME}({});`,
				description: `run ${toolCallId}`,
			},
			undefined,
			undefined,
			harness.ctx,
		);

	const firstPending = execute("renderer-first");
	await firstStarted;
	harness.registerRuntimeTool(
		VISUAL_RUNTIME_TOOL_NAME,
		secondExecutable,
		definition("second renderer"),
	);
	const secondResult = await execute("renderer-second");
	harness.pi.setActiveTools([]);
	releaseFirst();
	const firstResult = await firstPending;

	assert.match(renderToolResult(tool, firstResult, "renderer-first"), /first renderer/);
	assert.doesNotMatch(
		renderToolResult(tool, firstResult, "renderer-first-copy"),
		/second renderer/,
	);
	assert.match(renderToolResult(tool, secondResult, "renderer-second"), /second renderer/);
	assert.doesNotMatch(JSON.stringify(firstResult.details), /first renderer|second renderer/);
	assert.doesNotMatch(JSON.stringify(secondResult.details), /first renderer|second renderer/);
});
