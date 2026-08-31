import { strict as assert } from "node:assert";
import test from "node:test";

import { Text } from "@earendil-works/pi-tui";
import { createPtcTool } from "../src/transport.ts";
import { createRenderContext, LIMITS, renderNestedResult } from "./support/transport-harness.ts";

test("lifecycle clear prevents an old clone from claiming a future same-ID renderer", async () => {
	let marker = "before clear renderer";
	const tool = createPtcTool({
		...LIMITS,
		createExecution(context) {
			const executionMarker = marker;
			return {
				definitions: new Map([
					[
						"custom",
						{
							renderCall: () => new Text(executionMarker, 0, 0),
						},
					],
				]),
				bindings: {
					custom: async () => {
						context.reportDispatch?.({ id: 1, name: "custom", args: {}, status: "ok" });
						return null;
					},
				},
			};
		},
		run: async (request) => {
			await request.bindings?.functions.custom?.({}, new AbortController().signal);
			return { logs: [], result: null };
		},
	});
	const execute = () =>
		tool.execute(
			"same-id-across-clear",
			{ code: "return null;", description: `run ${marker}` },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);
	const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

	const first = await execute();
	const staleFirst = clone(first);
	tool.clearRenderSnapshots();
	marker = "after clear renderer";
	const second = await execute();
	const staleOutput = renderNestedResult(tool, staleFirst, "same-id-across-clear");
	assert.doesNotMatch(staleOutput, /before clear renderer|after clear renderer/);
	assert.match(staleOutput, /custom/);
	assert.match(renderNestedResult(tool, second, "same-id-across-clear"), /after clear renderer/);
	const clonedSecondOutput = renderNestedResult(tool, clone(second), "same-id-across-clear");
	assert.doesNotMatch(clonedSecondOutput, /before clear renderer|after clear renderer/);
	assert.match(clonedSecondOutput, /custom/);
});

test("details-identity renderer attachments stay scoped to their createPtcTool instance", async () => {
	const sourceTool = createPtcTool({
		...LIMITS,
		createExecution(context) {
			return {
				definitions: new Map([
					[
						"custom",
						{
							renderCall: () => new Text("source-only renderer", 0, 0),
						},
					],
				]),
				bindings: {
					custom: async () => {
						context.reportDispatch?.({ id: 1, name: "custom", args: {}, status: "ok" });
						return null;
					},
				},
			};
		},
		run: async (request) => {
			await request.bindings?.functions.custom?.({}, new AbortController().signal);
			return { logs: [], result: null };
		},
	});
	const foreignTool = createPtcTool({
		...LIMITS,
		createBindings: () => ({}),
	});
	const result = await sourceTool.execute(
		"instance-scoped-renderer",
		{ code: "return null;", description: "scope renderer" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);

	const foreignOutput = renderNestedResult(foreignTool, result, "instance-scoped-renderer");
	assert.doesNotMatch(foreignOutput, /source-only renderer/);
	assert.match(foreignOutput, /custom/);
});

test("tool-call renderer snapshots survive details replacement and transfer into the root", async () => {
	const tool = createPtcTool({
		...LIMITS,
		createExecution(context) {
			return {
				definitions: new Map([
					[
						"custom",
						{
							renderCall: () => new Text("replacement renderer", 0, 0),
						},
					],
				]),
				bindings: {
					custom: async () => {
						context.reportDispatch?.({ id: 1, name: "custom", args: {}, status: "ok" });
						return null;
					},
				},
			};
		},
		run: async (request) => {
			await request.bindings?.functions.custom?.({}, new AbortController().signal);
			return { logs: [], result: null };
		},
	});
	const result = await tool.execute(
		"details-replaced",
		{ code: "return null;", description: "replace details" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	const downstreamResult = {
		...result,
		details: JSON.parse(JSON.stringify(result.details)) as typeof result.details,
	};
	const context = createRenderContext("details-replaced");

	assert.match(
		renderNestedResult(tool, downstreamResult, "details-replaced", context),
		/replacement renderer/,
	);
	assert.doesNotMatch(
		renderNestedResult(tool, result, "details-replaced", createRenderContext("details-replaced")),
		/replacement renderer/,
	);
	tool.clearRenderSnapshots();
	const rerenderedResult = {
		...downstreamResult,
		details: JSON.parse(JSON.stringify(downstreamResult.details)) as typeof result.details,
	};
	assert.match(
		renderNestedResult(tool, rerenderedResult, "details-replaced", context),
		/replacement renderer/,
	);
	assert.equal(JSON.stringify(result).includes("replacement renderer"), false);
});

test("clear and eviction revoke renderer tokens attached to original details", async () => {
	let marker = "first attached renderer";
	const tool = createPtcTool({
		...LIMITS,
		maxPendingRenderSnapshots: 1,
		createExecution(context) {
			const executionMarker = marker;
			return {
				definitions: new Map([
					[
						"custom",
						{
							renderCall: () => new Text(executionMarker, 0, 0),
						},
					],
				]),
				bindings: {
					custom: async () => {
						context.reportDispatch?.({ id: 1, name: "custom", args: {}, status: "ok" });
						return null;
					},
				},
			};
		},
		run: async (request) => {
			await request.bindings?.functions.custom?.({}, new AbortController().signal);
			return { logs: [], result: null };
		},
	});
	const execute = (toolCallId: string) =>
		tool.execute(
			toolCallId,
			{ code: "return null;", description: `run ${toolCallId}` },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);

	const evicted = await execute("attached-evicted");
	marker = "second attached renderer";
	const cleared = await execute("attached-cleared");
	assert.doesNotMatch(
		renderNestedResult(tool, evicted, "attached-evicted"),
		/first attached renderer/,
	);

	tool.clearRenderSnapshots();
	assert.doesNotMatch(
		renderNestedResult(tool, cleared, "attached-cleared"),
		/second attached renderer/,
	);
});

test("renderer lifecycle epoch rejects definitions from an execution settling after clear", async () => {
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tool = createPtcTool({
		...LIMITS,
		createExecution(context) {
			return {
				definitions: new Map([
					[
						"custom",
						{
							renderCall: () => new Text("late settlement renderer", 0, 0),
						},
					],
				]),
				bindings: {
					custom: async () => {
						context.reportDispatch?.({ id: 1, name: "custom", args: {}, status: "ok" });
						return null;
					},
				},
			};
		},
		run: async (request) => {
			markStarted();
			await gate;
			await request.bindings?.functions.custom?.({}, new AbortController().signal);
			return { logs: [], result: null };
		},
	});
	const pending = tool.execute(
		"late-settlement",
		{ code: "return null;", description: "settle after clear" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);

	await started;
	tool.clearRenderSnapshots();
	release();
	const result = await pending;

	assert.doesNotMatch(
		renderNestedResult(tool, result, "late-settlement"),
		/late settlement renderer/,
	);
});

test("unrendered tool-call renderer snapshots evict at the named bound and clear explicitly", async () => {
	let marker = "";
	const tool = createPtcTool({
		...LIMITS,
		maxPendingRenderSnapshots: 2,
		createExecution(context) {
			const executionMarker = marker;
			return {
				definitions: new Map([
					[
						"custom",
						{
							renderCall: () => new Text(executionMarker, 0, 0),
						},
					],
				]),
				bindings: {
					custom: async () => {
						context.reportDispatch?.({ id: 1, name: "custom", args: {}, status: "ok" });
						return null;
					},
				},
			};
		},
		run: async (request) => {
			await request.bindings?.functions.custom?.({}, new AbortController().signal);
			return { logs: [], result: null };
		},
	});
	const execute = async (toolCallId: string, rendererMarker: string) => {
		marker = rendererMarker;
		const result = await tool.execute(
			toolCallId,
			{ code: "return null;", description: `run ${toolCallId}` },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);
		return {
			...result,
			details: JSON.parse(JSON.stringify(result.details)) as typeof result.details,
		};
	};

	const first = await execute("evicted-first", "first pending renderer");
	const second = await execute("retained-second", "second pending renderer");
	const third = await execute("retained-third", "third pending renderer");
	assert.doesNotMatch(renderNestedResult(tool, first, "evicted-first"), /first pending renderer/);
	assert.match(renderNestedResult(tool, second, "retained-second"), /second pending renderer/);
	assert.match(renderNestedResult(tool, third, "retained-third"), /third pending renderer/);

	const cleared = await execute("cleared-fourth", "fourth pending renderer");
	tool.clearRenderSnapshots();
	assert.doesNotMatch(
		renderNestedResult(tool, cleared, "cleared-fourth"),
		/fourth pending renderer/,
	);
});
