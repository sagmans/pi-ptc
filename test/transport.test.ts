import { strict as assert } from "node:assert";
import test from "node:test";

import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";

import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
	createCoreBindings,
	createToolBindings,
	type DispatchLogEntry,
	type DispatchProgress,
	type DispatchRenderResult,
} from "../src/bridge.ts";
import { SHIPPED_PTC_CONFIG, TRUST_COPY } from "../src/config.ts";
import type {
	CapturedPiSession,
	PiRuntimeActionsInstallation,
	PiRuntimeEventFinalizersInstallation,
} from "../src/pi-runtime.ts";
import type { PtcRenderContext } from "../src/renderer.ts";
import { createScheduler } from "../src/scheduler.ts";
import type { ToolCatalogEntry } from "../src/tool-catalog.ts";
import { createToolExecutor } from "../src/tool-executor.ts";
import { createPtcTool, type PtcPartialResult } from "../src/transport.ts";

const CUSTOM_DRAIN_TIMEOUT_MS = 321;
const CUSTOM_MAX_DISPATCHES = 37;
const CUSTOM_MAX_ORPHANED_BINDINGS = 4;
const CUSTOM_MAX_OUTPUT_BYTES = 1234;
const CUSTOM_MAX_OUTPUT_LINES = 56;
const CUSTOM_MAX_PERSISTED_DETAILS_BYTES = 2345;
const SCALING_DISPATCH_COUNT = 100;
const SCALING_DESCRIPTION = "inspect dispatch scaling";
const SCALING_ACCESS_BOUND_PER_DISPATCH = 20;
const RETENTION_RENDER_BUDGET_BYTES = 64;
const OVERSIZED_RETAINED_TEXT = "r".repeat(RETENTION_RENDER_BUDGET_BYTES + 1);
const FIRST_RETAINED_RESULT_TEXT = "first retained result";
const SECOND_RETAINED_RESULT_TEXT = "second retained resul";
const FIRST_RETAINED_RESULT = {
	content: [{ type: "text", text: FIRST_RETAINED_RESULT_TEXT }],
	isError: false,
} satisfies DispatchRenderResult;
const SECOND_RETAINED_RESULT = {
	content: [{ type: "text", text: SECOND_RETAINED_RESULT_TEXT }],
	isError: false,
} satisfies DispatchRenderResult;
const SINGLE_RETAINED_RESULT_BUDGET_BYTES = Buffer.byteLength(
	JSON.stringify(FIRST_RETAINED_RESULT),
	"utf8",
);
const HOSTILE_RENDER_DETAILS_MESSAGE = "hostile render details";
const TIMER_TEST_INTERVAL_MS = 5;
const TIMER_IDLE_OBSERVATION_MS = 30;
const OVERSIZED_FAILURE_MESSAGE = "failure".repeat(1000);
const RAW_CUSTOM_SECRET = "RAW_CUSTOM_SECRET";
const RAW_CUSTOM_DETAILS_MARKER = "RAW_CUSTOM_DETAILS_MARKER";
const CUSTOM_CALL_MARKER = "custom call";
const CUSTOM_RESULT_MARKER = "custom finalized result";

type PtcExecuteReport = (progress: DispatchProgress) => void;

const TIMER_THEME = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const LIMITS = {
	timeoutMs: 2000,
	maxDispatches: SHIPPED_PTC_CONFIG.maxDispatches,
	maxOutputBytes: 51200,
	maxOutputLines: 2000,
};

initTheme(undefined, false);

test("ptc description names bash-equivalent trust and active runtime tools", () => {
	const tool = createPtcTool({
		...LIMITS,
		createBindings: () => ({}),
	});
	assert.match(tool.description, new RegExp(TRUST_COPY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(tool.description, /active runtime tools/);
	assert.equal(tool.promptSnippet, "Run a program against active runtime tools");
	assert.equal(tool.name, "ptc");
});

function createRenderContext(toolCallId: string): PtcRenderContext {
	return {
		toolCallId,
		cwd: process.cwd(),
		state: {},
		invalidate: () => undefined,
		lastComponent: undefined,
		expanded: false,
		showImages: false,
		isError: false,
	};
}

function renderNestedResult(
	tool: ReturnType<typeof createPtcTool>,
	result: Awaited<ReturnType<ReturnType<typeof createPtcTool>["execute"]>>,
	toolCallId = "custom-live",
	context = createRenderContext(toolCallId),
): string {
	return tool
		.renderResult(result, { expanded: false, isPartial: false }, TIMER_THEME, context)
		.render(120)
		.map((line) => stripTerminalSequences(line).trim())
		.filter(Boolean)
		.join("\n");
}

test("live custom renderers receive raw args and finalized non-JSON results without leaks", async () => {
	const cyclicDetails: Record<string, unknown> = { marker: RAW_CUSTOM_DETAILS_MARKER };
	cyclicDetails.self = cyclicDetails;
	let renderedArgs: unknown;
	let renderedResult: unknown;
	let renderedPartial: boolean | undefined;
	let renderedError: boolean | undefined;
	const definition = {
		name: "custom_tool",
		renderShell: "self",
		renderCall(args: unknown) {
			renderedArgs = args;
			return new Text(CUSTOM_CALL_MARKER, 0, 0);
		},
		renderResult(
			result: unknown,
			options: { isPartial: boolean },
			_theme: Theme,
			context: { isError: boolean },
		) {
			renderedResult = result;
			renderedPartial = options.isPartial;
			renderedError = context.isError;
			return new Text(CUSTOM_RESULT_MARKER, 0, 0);
		},
	};
	const entry: ToolCatalogEntry = {
		name: "custom_tool",
		definition,
		executable: {
			parameters: Type.Object({
				token: Type.String(),
				nested: Type.Object({ exact: Type.Array(Type.Number()) }),
			}),
			async execute() {
				return {
					content: [{ type: "text", text: "before hook" }],
					details: { phase: "before" },
				};
			},
		},
	};
	const catalog = [entry] as const;
	const session: CapturedPiSession = {
		version: "0.84.3",
		extensionRunner: {
			createContext: () => ({}),
			emit: async () => undefined,
		},
		sharedRuntime: {
			getActiveTools: () => [entry.name],
			setActiveTools() {},
			refreshTools() {},
		},
		toolRegistry: new Map([[entry.name, entry.executable]]),
		beforeToolCall: async () => undefined,
		afterToolCall: async () => ({
			content: [{ type: "text", text: "after hook" }],
			details: cyclicDetails,
		}),
		getToolDefinition: () => definition,
		installRuntimeActions(): PiRuntimeActionsInstallation {
			throw new Error("not used");
		},
		installRuntimeEventFinalizers(): PiRuntimeEventFinalizersInstallation {
			throw new Error("not used");
		},
	};
	const executor = createToolExecutor({ catalog, session });
	const logs: DispatchLogEntry[] = [];
	const events: unknown[] = [];
	const reported: DispatchProgress[] = [];
	const tool = createPtcTool({
		...LIMITS,
		definitionProvider: () => catalog,
		createBindings: (context) =>
			createToolBindings(catalog, executor, createScheduler(1), {
				reportDispatch(progress) {
					reported.push(progress);
					context.reportDispatch?.(progress);
				},
				appendLog: (entry) => logs.push(entry),
				emit: (_name, payload) => events.push(payload),
			}),
	});
	const result = await tool.execute(
		"custom-live",
		{
			code: `return await tools.custom_tool({ token: ${JSON.stringify(RAW_CUSTOM_SECRET)}, nested: { exact: [1, 2, 3] } });`,
			description: "run custom tool",
		},
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	const output = renderNestedResult(tool, result);
	const rawResult = renderedResult as { content: Array<{ text: string }>; details: unknown };

	assert.deepEqual(renderedArgs, {
		token: RAW_CUSTOM_SECRET,
		nested: { exact: [1, 2, 3] },
	});
	assert.equal(rawResult.content[0]?.text, "after hook");
	assert.equal(rawResult.details, cyclicDetails);
	assert.equal(renderedPartial, false);
	assert.equal(renderedError, false);
	assert.match(output, new RegExp(CUSTOM_CALL_MARKER));
	assert.match(output, new RegExp(CUSTOM_RESULT_MARKER));
	assert.doesNotMatch(output, /before hook/);
	assert.equal(result.details.dispatches[0]?.renderOmitted, "incompatible");
	assert.equal(JSON.stringify(result.details).includes(RAW_CUSTOM_SECRET), false);
	assert.equal(result.content[0]?.text.includes(RAW_CUSTOM_SECRET), false);
	assert.equal(JSON.stringify(logs).includes(RAW_CUSTOM_SECRET), false);
	assert.equal(JSON.stringify(events).includes(RAW_CUSTOM_SECRET), false);
	const serializedReports = JSON.stringify(reported);
	assert.equal(serializedReports.includes(RAW_CUSTOM_SECRET), false);
	assert.equal(serializedReports.includes(RAW_CUSTOM_DETAILS_MARKER), false);
});

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

test("ptc returns logs and a curated result", async () => {
	const tool = createPtcTool({
		...LIMITS,
		createBindings: () => ({
			echo: async (args) => args,
		}),
	});
	const result = await tool.execute(
		"call-1",
		{ code: 'console.log("hi"); return await tools.echo({ n: 2 });', description: "echo" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	assert.equal(result.content[0]?.type, "text");
	assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), {
		logs: ["hi"],
		result: { n: 2 },
	});
});

test("ptc rejects an oversized outer result", async () => {
	const tool = createPtcTool({
		timeoutMs: LIMITS.timeoutMs,
		maxDispatches: LIMITS.maxDispatches,
		maxOutputBytes: 16,
		maxOutputLines: 2000,
		createBindings: () => ({}),
	});
	await assert.rejects(
		() =>
			tool.execute(
				"call-2",
				{ code: 'return "0123456789abcdef";', description: "overflow" },
				undefined,
				undefined,
				{ cwd: process.cwd() },
			),
		/outer result exceeds/,
	);
});

test("ptc bounds worker failure messages before Pi persists them", async () => {
	const tool = createPtcTool({
		...LIMITS,
		maxOutputBytes: CUSTOM_MAX_OUTPUT_BYTES,
		maxOutputLines: CUSTOM_MAX_OUTPUT_LINES,
		createBindings: () => ({}),
	});
	let rejection: Error | undefined;

	try {
		await tool.execute(
			"call-large-failure",
			{
				code: `throw new Error(${JSON.stringify(OVERSIZED_FAILURE_MESSAGE)});`,
				description: "bound a worker failure",
			},
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);
	} catch (error) {
		rejection = error as Error;
	}

	assert.equal(rejection?.message, "ptc failed (output-limit): output-limit");
	assert.ok(Buffer.byteLength(rejection?.message ?? "", "utf8") <= CUSTOM_MAX_OUTPUT_BYTES);
});

test("ptc forwards output and dispatch limits into the runtime seam", async () => {
	let captured:
		| {
				drainTimeoutMs?: number;
				maxBindingCalls?: number;
				maxOrphanedBindings?: number;
				maxOutputBytes?: number;
				maxOutputLines?: number;
		  }
		| undefined;
	const tool = createPtcTool({
		timeoutMs: LIMITS.timeoutMs,
		drainTimeoutMs: CUSTOM_DRAIN_TIMEOUT_MS,
		maxDispatches: CUSTOM_MAX_DISPATCHES,
		maxOrphanedBindings: CUSTOM_MAX_ORPHANED_BINDINGS,
		maxOutputBytes: CUSTOM_MAX_OUTPUT_BYTES,
		maxOutputLines: CUSTOM_MAX_OUTPUT_LINES,
		maxPersistedDetailsBytes: CUSTOM_MAX_PERSISTED_DETAILS_BYTES,
		createBindings: () => ({}),
		run: async (request) => {
			captured = request;
			return { logs: [], result: null };
		},
	});

	await tool.execute(
		"call-limits",
		{ code: "return null;", description: "check limits" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);

	assert.equal(captured?.drainTimeoutMs, CUSTOM_DRAIN_TIMEOUT_MS);
	assert.equal(captured?.maxBindingCalls, CUSTOM_MAX_DISPATCHES);
	assert.equal(captured?.maxOrphanedBindings, CUSTOM_MAX_ORPHANED_BINDINGS);
	assert.equal(captured?.maxOutputBytes, CUSTOM_MAX_OUTPUT_BYTES);
	assert.equal(captured?.maxOutputLines, CUSTOM_MAX_OUTPUT_LINES);
});

test("forced timeout, drain, and orphan terminalization preserves raw custom arguments without leaks", async () => {
	for (const failureKind of ["timeout", "dangling-dispatch", "orphan-limit"] as const) {
		const secret = `${RAW_CUSTOM_SECRET}:${failureKind}`;
		const rawArgs = { token: secret, nested: { exact: [1, 2, 3] } };
		let renderedArgs: unknown;
		const logs: DispatchLogEntry[] = [];
		const events: unknown[] = [];
		const reported: DispatchProgress[] = [];
		const updates: PtcPartialResult[] = [];
		const entry: ToolCatalogEntry = {
			name: "custom_terminal",
			definition: {
				renderCall(args: unknown) {
					renderedArgs = args;
					return new Text(`custom ${failureKind} call`, 0, 0);
				},
			},
			executable: {
				parameters: Type.Object({
					token: Type.String(),
					nested: Type.Object({ exact: Type.Array(Type.Number()) }),
				}),
				async execute() {
					return { content: [] };
				},
			},
		};
		const catalog = [entry] as const;
		const executor = {
			async dispatch() {
				return await new Promise<never>(() => undefined);
			},
		};
		const tool = createPtcTool({
			...LIMITS,
			definitionProvider: () => catalog,
			createBindings: (context) =>
				createToolBindings(catalog, executor, createScheduler(1), {
					reportDispatch(progress) {
						reported.push(progress);
						context.reportDispatch?.(progress);
					},
					appendLog: (entry) => logs.push(entry),
					emit: (_name, payload) => events.push(payload),
				}),
			run: async (request) => {
				void request.bindings?.functions.custom_terminal?.(rawArgs, new AbortController().signal);
				await waitForUpdates(updates, 1);
				return { logs: [], error: { kind: failureKind } };
			},
		});

		await assert.rejects(
			() =>
				tool.execute(
					`terminal-${failureKind}`,
					{ code: "return null;", description: `force ${failureKind}` },
					undefined,
					(partial) => updates.push(partial),
					{ cwd: process.cwd() },
				),
			/ptc failed/,
		);
		const terminal = updates.at(-1);
		assert.equal(terminal?.details.dispatches[0]?.status, "err");
		const output = renderNestedResult(tool, terminal as PtcPartialResult);

		assert.deepEqual(renderedArgs, rawArgs);
		assert.match(output, new RegExp(`custom ${failureKind} call`));
		for (const retained of [terminal?.details, terminal?.content, reported, logs, events]) {
			assert.equal(JSON.stringify(retained).includes(secret), false, failureKind);
		}
	}
});

test("ptc terminalizes and quarantines dispatches left active at runtime settlement", async () => {
	const updates: PtcPartialResult[] = [];
	let reportDispatch: PtcExecuteReport | undefined;
	const tool = createPtcTool({
		...LIMITS,
		createBindings: (ctx) => {
			reportDispatch = ctx.reportDispatch;
			return {};
		},
		run: async () => {
			reportDispatch?.({
				id: 1,
				name: "read",
				args: { path: "stalled.txt" },
				status: "start",
			});
			return { logs: [], error: { kind: "timeout" } };
		},
	});

	await assert.rejects(
		() =>
			tool.execute(
				"call-stalled",
				{ code: "return null;", description: "settle stalled dispatch" },
				undefined,
				(partial) => updates.push(partial),
				{ cwd: process.cwd() },
			),
		/timeout/,
	);

	assert.equal(updates.at(-1)?.details.dispatches[0]?.status, "err");
	const updateCountAfterSettlement = updates.length;
	reportDispatch?.({
		id: 1,
		name: "read",
		args: { path: "stalled.txt" },
		status: "ok",
		result: { content: [{ type: "text", text: "late" }], isError: false },
	});
	assert.equal(updates.length, updateCountAfterSettlement);
});

test("ptc abort reaches an active core executor before settlement", async () => {
	let markExecutorStarted!: () => void;
	const executorStarted = new Promise<void>((resolve) => {
		markExecutorStarted = resolve;
	});
	let executorSignal: AbortSignal | undefined;
	const tool = createPtcTool({
		...LIMITS,
		createBindings: () =>
			createCoreBindings({
				execute: async (_name, _args, signal) => {
					executorSignal = signal;
					markExecutorStarted();
					if (signal && !signal.aborted) {
						await new Promise<void>((resolve) => {
							signal.addEventListener("abort", () => resolve(), { once: true });
						});
					}
					return { content: [] };
				},
				scheduler: createScheduler(1),
			}),
	});
	const controller = new AbortController();
	const pending = tool.execute(
		"call-3",
		{ code: 'await tools.read({ path: "note.txt" }); return 1;', description: "hang" },
		controller.signal,
		undefined,
		{ cwd: process.cwd() },
	);
	await executorStarted;
	controller.abort();
	await assert.rejects(pending, /abort/);
	assert.equal(executorSignal?.aborted, true);
});

test("terminal abort updates clear the native bash timer before outer rejection", {
	concurrency: false,
}, async () => {
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	const activeIntervals = new Set<ReturnType<typeof setInterval>>();
	let intervalCreations = 0;
	let intervalClears = 0;
	globalThis.setInterval = ((...parameters: Parameters<typeof setInterval>) => {
		const [callback, _delay, ...args] = parameters;
		intervalCreations += 1;
		const handle = originalSetInterval(callback, TIMER_TEST_INTERVAL_MS, ...args);
		activeIntervals.add(handle);
		return handle;
	}) as typeof setInterval;
	globalThis.clearInterval = ((handle) => {
		intervalClears += 1;
		activeIntervals.delete(handle as ReturnType<typeof setInterval>);
		originalClearInterval(handle);
	}) as typeof clearInterval;

	try {
		let markExecutorStarted!: () => void;
		const executorStarted = new Promise<void>((resolve) => {
			markExecutorStarted = resolve;
		});
		let rejectionObserved = false;
		let terminalObserved = false;
		let invalidations = 0;
		const renderContext: PtcRenderContext = {
			toolCallId: "timer-abort",
			cwd: process.cwd(),
			state: {},
			invalidate: () => {
				invalidations += 1;
			},
			lastComponent: undefined,
			expanded: false,
			showImages: false,
			isError: false,
		};
		const tool = createPtcTool({
			...LIMITS,
			createBindings: (ctx) =>
				createCoreBindings({
					execute: async (_name, _args, signal, onUpdate) => {
						onUpdate?.({ content: [{ type: "text", text: "working" }] });
						markExecutorStarted();
						await new Promise<void>((_resolve, reject) => {
							if (signal?.aborted) {
								reject(new Error("aborted"));
								return;
							}
							signal?.addEventListener("abort", () => reject(new Error("aborted")), {
								once: true,
							});
						});
						return { content: [] };
					},
					reportDispatch: ctx.reportDispatch,
					scheduler: createScheduler(1),
				}),
		});
		const controller = new AbortController();
		const pending = tool.execute(
			"timer-abort",
			{
				code: 'await tools.bash({ command: "wait" });',
				description: "abort timed bash",
			},
			controller.signal,
			(partial) => {
				const status = partial.details.dispatches[0]?.status;
				tool.renderResult(
					partial,
					{ expanded: false, isPartial: status === "start" },
					TIMER_THEME,
					renderContext,
				);
				if (status === "err") {
					terminalObserved = true;
					assert.equal(rejectionObserved, false);
				}
			},
			{ cwd: process.cwd() },
		);

		await executorStarted;
		assert.equal(intervalCreations, 1);
		controller.abort();
		await assert.rejects(pending, /abort/i);
		rejectionObserved = true;
		assert.equal(terminalObserved, true);
		assert.equal(intervalClears, 1);
		assert.equal(activeIntervals.size, 0);
		const invalidationsAfterSettlement = invalidations;
		await new Promise((resolve) => setTimeout(resolve, TIMER_IDLE_OBSERVATION_MS));
		assert.equal(invalidations, invalidationsAfterSettlement);
	} finally {
		for (const handle of activeIntervals) originalClearInterval(handle);
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	}
});

async function waitForUpdates(updates: unknown[], count: number, timeoutMs = 1000): Promise<void> {
	const started = Date.now();
	while (updates.length < count) {
		if (Date.now() - started > timeoutMs) {
			throw new Error(`timed out waiting for ${count} updates, got ${updates.length}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("ptc keeps 100 progress payloads proportional to the report count", async () => {
	const updates: PtcPartialResult[] = [];
	let propertyAccesses = 0;
	let reportDispatch: PtcExecuteReport | undefined;
	const tool = createPtcTool({
		...LIMITS,
		createBindings: (ctx) => {
			reportDispatch = ctx.reportDispatch;
			return {};
		},
		run: async () => {
			for (let id = SCALING_DISPATCH_COUNT; id >= 1; id -= 1) {
				const args = new Proxy(
					{ path: `file-${id}.txt` },
					{
						get(target, key, receiver) {
							propertyAccesses += 1;
							return Reflect.get(target, key, receiver);
						},
						ownKeys(target) {
							propertyAccesses += 1;
							return Reflect.ownKeys(target);
						},
					},
				);
				const result = new Proxy(
					{
						content: [{ type: "text", text: `result-${id}` }],
						isError: false,
					},
					{
						get(target, key, receiver) {
							propertyAccesses += 1;
							return Reflect.get(target, key, receiver);
						},
					},
				) as DispatchRenderResult;
				reportDispatch?.({ id, name: "read", args, status: "ok", result });
			}
			return { logs: [], result: null };
		},
	});

	const result = await tool.execute(
		"call-scaling",
		{ code: "return null;", description: SCALING_DESCRIPTION },
		undefined,
		(partial) => updates.push(partial),
		{ cwd: process.cwd() },
	);

	assert.equal(updates.length, SCALING_DISPATCH_COUNT);
	assert.equal(
		updates.reduce((count, update) => count + update.details.dispatches.length, 0),
		SCALING_DISPATCH_COUNT,
	);
	assert.equal(
		updates.reduce((count, update) => count + (update.content[0]?.text.split("\n").length ?? 0), 0),
		SCALING_DISPATCH_COUNT,
	);
	for (const update of updates) {
		assert.equal(update.details.mode, "delta");
		assert.equal(update.details.dispatches.length, 1);
	}
	assert.equal(result.details.mode, "snapshot");
	assert.deepEqual(
		result.details.dispatches.map((dispatch) => dispatch.id),
		Array.from({ length: SCALING_DISPATCH_COUNT }, (_, index) => index + 1),
	);
	assert.ok(propertyAccesses <= SCALING_ACCESS_BOUND_PER_DISPATCH * SCALING_DISPATCH_COUNT);
});

test("render projection failures do not fail dispatch execution", async () => {
	const updates: PtcPartialResult[] = [];
	let reportDispatch: PtcExecuteReport | undefined;
	const hostileDetails = new Proxy(
		{},
		{
			ownKeys: () => {
				throw new Error(HOSTILE_RENDER_DETAILS_MESSAGE);
			},
		},
	);
	const tool = createPtcTool({
		...LIMITS,
		createBindings: (ctx) => {
			reportDispatch = ctx.reportDispatch;
			return {};
		},
		run: async () => {
			reportDispatch?.({
				id: 1,
				name: "bash",
				args: { command: "printf safe" },
				status: "ok",
				preview: "safe preview",
				result: { content: [], details: hostileDetails, isError: false },
			});
			return { logs: [], result: "completed" };
		},
	});

	const result = await tool.execute(
		"call-hostile-render",
		{ code: "return null;", description: "ignore hostile render details" },
		undefined,
		(partial) => updates.push(partial),
		{ cwd: process.cwd() },
	);

	const expectedDispatch = {
		id: 1,
		name: "bash",
		args: { command: "printf safe" },
		status: "ok",
		preview: "safe preview",
		renderOmitted: "incompatible",
	};
	assert.deepEqual(result.details.dispatches, [expectedDispatch]);
	assert.deepEqual(updates[0]?.details.dispatches, [expectedDispatch]);
	assert.ok((result.details.compatibilityError?.length ?? 0) > 0);
});

test("transport accounts for retained render projections across dispatch ids", async () => {
	const updates: PtcPartialResult[] = [];
	let reportDispatch: PtcExecuteReport | undefined;
	const tool = createPtcTool({
		...LIMITS,
		maxRenderDetailsBytes: SINGLE_RETAINED_RESULT_BUDGET_BYTES,
		createBindings: (ctx) => {
			reportDispatch = ctx.reportDispatch;
			return {};
		},
		run: async () => {
			reportDispatch?.({
				id: 1,
				name: "read",
				args: { path: "first.txt" },
				status: "ok",
				result: FIRST_RETAINED_RESULT,
			});
			reportDispatch?.({
				id: 2,
				name: "read",
				args: { path: "second.txt" },
				status: "ok",
				result: SECOND_RETAINED_RESULT,
			});
			return { logs: [], result: null };
		},
	});

	const result = await tool.execute(
		"call-retained-accounting",
		{ code: "return null;", description: "account retained projections" },
		undefined,
		(partial) => updates.push(partial),
		{ cwd: process.cwd() },
	);

	assert.equal(
		Buffer.byteLength(JSON.stringify(FIRST_RETAINED_RESULT), "utf8"),
		SINGLE_RETAINED_RESULT_BUDGET_BYTES,
	);
	assert.equal(
		Buffer.byteLength(JSON.stringify(SECOND_RETAINED_RESULT), "utf8"),
		SINGLE_RETAINED_RESULT_BUDGET_BYTES,
	);
	assert.deepEqual(updates[0]?.details.dispatches[0]?.result, FIRST_RETAINED_RESULT);
	assert.deepEqual(updates[1]?.details.dispatches, [
		{
			id: 2,
			name: "read",
			args: { path: "second.txt" },
			status: "ok",
			renderOmitted: "budget",
		},
	]);
	assert.deepEqual(result.details.dispatches, [
		{
			id: 1,
			name: "read",
			args: { path: "first.txt" },
			status: "ok",
			result: FIRST_RETAINED_RESULT,
		},
		{
			id: 2,
			name: "read",
			args: { path: "second.txt" },
			status: "ok",
			renderOmitted: "budget",
		},
	]);
});

test("transport does not revisit raw results after retaining a bounded projection", async () => {
	const updates: PtcPartialResult[] = [];
	let textReads = 0;
	let textReadsAfterReport = 0;
	let reportDispatch: PtcExecuteReport | undefined;
	const contentBlock = {
		type: "text",
		get text() {
			textReads += 1;
			return OVERSIZED_RETAINED_TEXT;
		},
	};
	const tool = createPtcTool({
		...LIMITS,
		maxRenderDetailsBytes: RETENTION_RENDER_BUDGET_BYTES,
		createBindings: (ctx) => {
			reportDispatch = ctx.reportDispatch;
			return {};
		},
		run: async () => {
			reportDispatch?.({
				id: 1,
				name: "read",
				args: { path: "large.txt" },
				status: "ok",
				result: { content: [contentBlock], isError: false },
			});
			textReadsAfterReport = textReads;
			return { logs: [], result: null };
		},
	});

	const result = await tool.execute(
		"call-retention",
		{ code: "return null;", description: "retain bounded projections" },
		undefined,
		(partial) => updates.push(partial),
		{ cwd: process.cwd() },
	);

	assert.equal(textReads, textReadsAfterReport);
	assert.deepEqual(result.details.dispatches, [
		{
			id: 1,
			name: "read",
			args: { path: "large.txt" },
			status: "ok",
			renderOmitted: "budget",
		},
	]);
	assert.equal(JSON.stringify(updates).includes(OVERSIZED_RETAINED_TEXT), false);
	assert.equal(JSON.stringify(result.details).includes(OVERSIZED_RETAINED_TEXT), false);
});

test("ptc streams dispatch start then ok through onUpdate", async () => {
	const updates: Array<{ content: Array<{ text: string }>; details: { dispatches: unknown[] } }> =
		[];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const secret = "SECRET_FILE_BYTES";
	const tool = createPtcTool({
		...LIMITS,
		createBindings: (ctx) =>
			createCoreBindings({
				execute: async () => {
					await gate;
					return { content: [{ type: "text", text: secret }] };
				},
				scheduler: createScheduler(2),
				reportDispatch: ctx.reportDispatch,
			}),
	});
	const pending = tool.execute(
		"call-4",
		{
			code: 'const r = await tools.read({ path: "note.txt" }); return r.text.length;',
			description: "read note",
		},
		undefined,
		(partial) => {
			updates.push(partial as (typeof updates)[number]);
		},
		{ cwd: process.cwd() },
	);
	await waitForUpdates(updates, 1);
	assert.equal(updates[0]?.content[0]?.text, "read … note.txt");
	assert.equal(JSON.stringify(updates).includes(secret), false);
	release();
	const result = await pending;
	assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), {
		logs: [],
		result: secret.length,
	});
	const persistedDispatch = {
		id: 1,
		name: "read",
		args: { path: "note.txt" },
		status: "ok",
		result: {
			content: [{ type: "text", text: secret }],
			isError: false,
		},
	};
	assert.deepEqual(result.details.dispatches, [persistedDispatch]);
	assert.deepEqual(updates.at(-1)?.details.dispatches, [persistedDispatch]);
	assert.equal(updates.at(-1)?.content[0]?.text, "read ok note.txt");
});
