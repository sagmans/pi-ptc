import { strict as assert } from "node:assert";
import test from "node:test";

import { Text } from "@earendil-works/pi-tui";
import { createPtcTool } from "../src/transport.ts";
import { createRenderContext, LIMITS, renderNestedResult } from "./support/transport-harness.ts";

test("transport keeps host-only renderer definitions isolated per concurrent execution", async () => {
	let currentMarker = "first renderer";
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let markFirstStarted!: () => void;
	const firstStarted = new Promise<void>((resolve) => {
		markFirstStarted = resolve;
	});
	const tool = createPtcTool({
		...LIMITS,
		createExecution(context) {
			const marker = currentMarker;
			return {
				definitions: new Map([
					[
						"custom",
						{
							renderCall: () => new Text(marker, 0, 0),
						},
					],
				]),
				bindings: {
					custom: async () => {
						context.reportDispatch?.({ id: 1, name: "custom", args: {}, status: "start" });
						if (marker === "first renderer") {
							markFirstStarted();
							await firstGate;
						}
						context.reportDispatch?.({ id: 1, name: "custom", args: {}, status: "ok" });
						return marker;
					},
				},
			};
		},
		run: async (request) => ({
			logs: [],
			result:
				(await request.bindings?.functions.custom?.({}, new AbortController().signal)) ?? null,
		}),
	});
	const execute = (toolCallId: string) =>
		tool.execute(
			toolCallId,
			{ code: "return null;", description: `run ${toolCallId}` },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);

	const firstPending = execute("definition-first");
	await firstStarted;
	currentMarker = "second renderer";
	const secondResult = await execute("definition-second");
	releaseFirst();
	const firstResult = await firstPending;

	const downstreamFirst = {
		...firstResult,
		details: JSON.parse(JSON.stringify(firstResult.details)) as typeof firstResult.details,
	};
	const downstreamSecond = {
		...secondResult,
		details: JSON.parse(JSON.stringify(secondResult.details)) as typeof secondResult.details,
	};
	const firstOutput = renderNestedResult(tool, downstreamFirst, "definition-first");
	const secondOutput = renderNestedResult(tool, downstreamSecond, "definition-second");
	assert.match(firstOutput, /first renderer/);
	assert.doesNotMatch(firstOutput, /second renderer/);
	assert.match(secondOutput, /second renderer/);
	assert.doesNotMatch(secondOutput, /first renderer/);
	assert.equal(JSON.stringify(firstResult.details).includes("renderer"), false);
	assert.equal(JSON.stringify(secondResult.details).includes("renderer"), false);
});

test("duplicate outstanding call IDs revoke both renderer snapshots", async () => {
	let marker = "first duplicate renderer";
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
	const execute = async () => {
		const result = await tool.execute(
			"duplicate-renderer-id",
			{ code: "return null;", description: `run ${marker}` },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);
		return {
			...result,
			details: JSON.parse(JSON.stringify(result.details)) as typeof result.details,
		};
	};

	const first = await execute();
	marker = "second duplicate renderer";
	const second = await execute();
	const firstOutput = renderNestedResult(tool, first, "duplicate-renderer-id");
	const secondOutput = renderNestedResult(tool, second, "duplicate-renderer-id");

	for (const output of [firstOutput, secondOutput]) {
		assert.doesNotMatch(output, /first duplicate renderer/);
		assert.doesNotMatch(output, /second duplicate renderer/);
		assert.match(output, /custom/);
	}
});

test("a stale clone cannot claim a renderer after its consumed call ID is reused", async () => {
	let marker = "first consumed renderer";
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
			"reused-consumed-id",
			{ code: "return null;", description: `run ${marker}` },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);
	const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

	const first = await execute();
	const staleFirst = clone(first);
	const firstContext = createRenderContext("reused-consumed-id");
	assert.match(
		renderNestedResult(tool, first, "reused-consumed-id", firstContext),
		/first consumed renderer/,
	);

	marker = "second consumed renderer";
	const second = await execute();
	const staleOutput = renderNestedResult(tool, staleFirst, "reused-consumed-id");
	assert.doesNotMatch(staleOutput, /first consumed renderer|second consumed renderer/);
	assert.match(staleOutput, /custom/);
	assert.match(renderNestedResult(tool, second, "reused-consumed-id"), /second consumed renderer/);
	const clonedSecondOutput = renderNestedResult(tool, clone(second), "reused-consumed-id");
	assert.doesNotMatch(clonedSecondOutput, /first consumed renderer|second consumed renderer/);
	assert.match(clonedSecondOutput, /custom/);
	const rerenderedFirst = renderNestedResult(tool, first, "reused-consumed-id", firstContext);
	assert.match(rerenderedFirst, /first consumed renderer/);
	assert.doesNotMatch(rerenderedFirst, /second consumed renderer/);
});

test("renderer uniqueness-history exhaustion permanently disables bare call-ID fallback", async () => {
	let marker = "";
	const tool = createPtcTool({
		...LIMITS,
		maxRendererCallIdHistory: 2,
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
		return await tool.execute(
			toolCallId,
			{ code: "return null;", description: `run ${toolCallId}` },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);
	};
	const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

	const first = await execute("history-first", "first history renderer");
	assert.match(renderNestedResult(tool, clone(first), "history-first"), /first history renderer/);
	const second = await execute("history-second", "second history renderer");
	const third = await execute("history-third", "third history renderer");
	for (const [result, toolCallId, rendererMarker] of [
		[second, "history-second", /second history renderer/],
		[third, "history-third", /third history renderer/],
	] as const) {
		const clonedOutput = renderNestedResult(tool, clone(result), toolCallId);
		assert.doesNotMatch(clonedOutput, rendererMarker);
		assert.match(clonedOutput, /custom/);
		assert.match(renderNestedResult(tool, result, toolCallId), rendererMarker);
	}
	const fourth = await execute("history-fourth", "fourth history renderer");
	const clonedFourthOutput = renderNestedResult(tool, clone(fourth), "history-fourth");
	assert.doesNotMatch(clonedFourthOutput, /fourth history renderer/);
	assert.match(clonedFourthOutput, /custom/);
	assert.match(renderNestedResult(tool, fourth, "history-fourth"), /fourth history renderer/);
});
