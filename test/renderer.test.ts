import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	initTheme,
	type Theme,
	ToolExecutionComponent,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, Text, type TUI } from "@earendil-works/pi-tui";

import type { DispatchProgress } from "../src/bridge.ts";
import { SHIPPED_PTC_CONFIG } from "../src/config.ts";
import { createDeltaDetails, createSnapshotDetails } from "../src/dispatch-details.ts";
import { attachPtcRenderDispatches, type PtcRenderContext } from "../src/renderer.ts";
import {
	createPtcTool,
	type PtcParams,
	type PtcPartialResult,
	type PtcToolResult,
} from "../src/transport.ts";

const ANSI_RED = "\u001b[31m";
const ANSI_RESET = "\u001b[0m";
const DESCRIPTION = "inspect package";
const PROGRAM = "return 1;";
const RENDER_TOOL_CALL_ID = "render-call";
const RENDER_WIDTH = 120;
const IMAGE_RENDER_WIDTH = 73;
const IMAGE_RESIZED_WIDTH = 41;
const EXPECTED_SINGLE_RENDER_COUNT = 1;
const RECONSTRUCTION_IDLE_MS = 30;
const RECONSTRUCTION_OUTER_MARKER = "HIDDEN_RECONSTRUCTION_OUTER";
const RENDERER_SOURCE = readFileSync(new URL("../src/renderer.ts", import.meta.url), "utf8");
const NATIVE_READ_CONTENT = "NATIVE_READ_CONTENT";
const OMITTED_READ_CONTENT = "OMITTED_READ_CONTENT";
const OMITTED_RENDER_BUDGET_BYTES = 1;
const LIVE_WRITE_CONTENT = "bounded live content";
const NATIVE_WRITE_RENDER_MARKER = "native write renderer";
const NATIVE_EDIT_RENDER_MARKER = "native edit renderer";
const LIVE_EDIT_ENTRY_LIMIT = 8;
const LIVE_EDIT_TEXT_LIMIT_BYTES = 192;
const OVERSIZED_LIVE_EDIT_TEXT = "x".repeat(LIVE_EDIT_TEXT_LIMIT_BYTES + 1);
const LOSSY_EDIT_PATH = "lossy.txt";
const LOSSY_EDIT_REPLACEMENT = "replacement";
const LOSSY_EDIT_OLD_PREFIX = "old";
const LOSSY_EDIT_NEW_PREFIX = "new";
const JPEG_IMAGE_DATA = "aW1hZ2U=";
const PNG_IMAGE_DATA = "cG5n";
const CONVERTED_IMAGE_DATA = "Y29udmVydGVk";
const IMAGE_FALLBACK_TEXT = "[Image: image/png]";
const ORIGINAL_THEME_TEXT = "ORIGINAL_THEME";
const UPDATED_THEME_TEXT = "UPDATED_THEME";
const CALLBACK_TEST_INTERVAL_MS = 60_000;
const CHILD_RENDER_FAILURE = "child render failure";
const CONSTRUCTOR_FAILURE = "constructor failure";
const INVALIDATE_FAILURE = "invalidate failure";
const OUTER_INVALIDATE_FAILURE = "outer invalidate failure";
const OUTER_FALLBACK_MARKER = "OUTER_PROGRAM_MARKER";
const RAW_VISIBLE_PREFIX = "before";
const RAW_VISIBLE_SUFFIX = "after";
const RAW_VISIBLE_TEXT = `${RAW_VISIBLE_PREFIX}${RAW_VISIBLE_SUFFIX}`;
const CALL_RENDER_FAILURE = `${RAW_VISIBLE_PREFIX}\u001b[2J${RAW_VISIBLE_SUFFIX}`;
const RESULT_RENDER_FAILURE = `${RAW_VISIBLE_PREFIX}\u001b]0;unsafe\u0007${RAW_VISIBLE_SUFFIX}`;
const EXTENDED_RENDER_CONTROL = `${RAW_VISIBLE_PREFIX}\u001b[?1049h\u001bc\u0007\u009b31m\u001bPpayload\u001b\\${RAW_VISIBLE_SUFFIX}`;
const RAW_CONTROL_SEQUENCES = [
	"\u001b[2J",
	"\u001b[H",
	"\u001b]0;unsafe-title\u0007",
	"\u001b]8;;https://unsafe.invalid\u0007\u001b]8;;\u0007",
	"\u001b_pi:unsafe\u0007",
] as const;
const LIMITS = {
	timeoutMs: 2000,
	maxDispatches: SHIPPED_PTC_CONFIG.maxDispatches,
	maxOutputBytes: 51200,
	maxOutputLines: 2000,
};

const THEME = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

initTheme(undefined, false);

type HostToolDefinition = NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>;

type RenderableTool = ReturnType<typeof createPtcTool> & {
	renderShell: "self";
	renderCall: (args: PtcParams, theme: Theme, context: PtcRenderContext) => Component;
	renderResult: (
		result: PtcPartialResult | PtcToolResult,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: PtcRenderContext,
	) => Component;
};

function createTool(): RenderableTool {
	return createPtcTool({
		...LIMITS,
		createBindings: () => ({}),
	}) as RenderableTool;
}

function createRenderContext(expanded: boolean, isError = false): PtcRenderContext {
	return {
		toolCallId: RENDER_TOOL_CALL_ID,
		cwd: process.cwd(),
		state: {},
		invalidate: () => undefined,
		lastComponent: undefined,
		expanded,
		showImages: false,
		isError,
	};
}

function render(component: Component, width = RENDER_WIDTH): string {
	return component
		.render(width)
		.map((line) => stripTerminalSequences(line).trim())
		.filter((line) => line.length > 0)
		.join("\n");
}

function renderRaw(component: Component, width = RENDER_WIDTH): string {
	return component.render(width).join("\n");
}

function loadDispatchFixture(name: string): unknown {
	return JSON.parse(
		readFileSync(new URL(`fixtures/dispatch-details/${name}`, import.meta.url), "utf8"),
	);
}

function createFreshOuter(
	details: unknown,
	isError = false,
): { component: ToolExecutionComponent; renderRequests(): number } {
	const tool = createTool();
	let requests = 0;
	const component = new ToolExecutionComponent(
		"ptc",
		RENDER_TOOL_CALL_ID,
		{ code: RECONSTRUCTION_OUTER_MARKER, description: DESCRIPTION },
		{ showImages: false },
		tool as unknown as HostToolDefinition,
		{
			requestRender: () => {
				requests += 1;
			},
		} as TUI,
		process.cwd(),
	);
	component.markExecutionStarted();
	component.setArgsComplete();
	component.setExpanded(true);
	component.updateResult(
		{
			content: [{ type: "text", text: RECONSTRUCTION_OUTER_MARKER }],
			details,
			isError,
		},
		false,
	);
	return { component, renderRequests: () => requests };
}

function resultWith(dispatches: PtcToolResult["details"]["dispatches"]): PtcToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify({ logs: [], result: { hidden: true } }) }],
		details: createSnapshotDetails(DESCRIPTION, dispatches),
	};
}

test("ptc hides its call shell, description, program, and outer return", () => {
	const tool = createTool();
	const args = { code: PROGRAM, description: DESCRIPTION };
	const emptyResult = resultWith([]);

	assert.equal(tool.renderShell, "self");
	assert.equal(render(tool.renderCall(args, THEME, createRenderContext(false))), "");
	assert.equal(render(tool.renderCall(args, THEME, createRenderContext(true))), "");
	assert.equal(
		render(
			tool.renderResult(
				emptyResult,
				{ expanded: false, isPartial: false },
				THEME,
				createRenderContext(false),
			),
		),
		"",
	);
});

test("ptc renders each running dispatch as its own native row", () => {
	const tool = createTool();
	const partial: PtcPartialResult = {
		content: [{ type: "text", text: "ignored" }],
		details: createSnapshotDetails(DESCRIPTION, [
			{ id: 1, name: "read", args: { path: "package.json" }, status: "start" },
			{ id: 2, name: "bash", args: { command: "npm test" }, status: "start" },
		]),
	};

	const output = render(
		tool.renderResult(
			partial,
			{ expanded: false, isPartial: true },
			THEME,
			createRenderContext(false),
		),
	);

	assert.match(output, /read package\.json/);
	assert.match(output, /\$ npm test/);
	assert.doesNotMatch(output, /…|✓|✗/);
});

test("ptc renders compact tool-specific output previews", () => {
	const tool = createTool();
	const result = resultWith([
		{ id: 1, name: "read", args: { path: "package.json" }, status: "ok", preview: "hidden" },
		{
			id: 2,
			name: "bash",
			args: { command: "npm test" },
			status: "ok",
			preview: "one\ntwo\nthree\nfour",
		},
		{
			id: 3,
			name: "grep",
			args: { pattern: "hit", path: "src" },
			status: "ok",
			preview: "a.ts:1:hit\nb.ts:2:hit\nc.ts:3:hit\nd.ts:4:hit",
		},
		{ id: 4, name: "edit", args: { path: "src/a.ts" }, status: "ok", preview: "hidden" },
	]);

	const output = render(
		tool.renderResult(
			result,
			{ expanded: false, isPartial: false },
			THEME,
			createRenderContext(false),
		),
	);

	assert.match(output, /read package\.json/);
	assert.match(output, /\$ npm test/);
	assert.match(output, /one\ntwo\nthree\nfour/);
	assert.match(output, /grep \/hit\/ in src/);
	assert.match(output, /a\.ts:1:hit/);
	assert.match(output, /edit src\/a\.ts/);
	assert.doesNotMatch(output, /✓|✗/);
});

test("ptc renders failed dispatch errors without exposing the transport", () => {
	const tool = createTool();
	const result = resultWith([
		{
			id: 1,
			name: "read",
			args: { path: "missing.txt" },
			status: "err",
			preview: "file not found",
		},
	]);

	const output = render(
		tool.renderResult(
			result,
			{ expanded: false, isPartial: false },
			THEME,
			createRenderContext(false),
		),
	);

	assert.match(output, /read missing\.txt/);
	assert.match(output, /file not found/);
	assert.doesNotMatch(output, /✗/);
});

test("ptc expanded rows use the native tool output", () => {
	const tool = createTool();
	const result = resultWith([
		{
			id: 1,
			name: "grep",
			args: {
				pattern: "needle",
				path: "src",
				options: { literal: true, limits: [1, 2] },
			},
			status: "ok",
			preview: "one\ntwo\nthree\nfour",
		},
	]);

	const output = render(
		tool.renderResult(
			result,
			{ expanded: true, isPartial: false },
			THEME,
			createRenderContext(true),
		),
	);

	assert.match(output, /grep \/needle\/ in src/);
	assert.match(output, /one\ntwo\nthree\nfour/);
	assert.doesNotMatch(output, /Arguments|Output|✓/);
});

test("ptc renders persisted native results after a JSON reload without an attachment", () => {
	const tool = createTool();
	const details = createSnapshotDetails(DESCRIPTION, [
		{
			id: 1,
			name: "read",
			args: { path: "note.txt" },
			status: "ok",
			result: {
				content: [{ type: "text", text: NATIVE_READ_CONTENT }],
				details: undefined,
				isError: false,
			},
		},
	]);
	const result: PtcToolResult = {
		content: [{ type: "text", text: "ignored" }],
		details: JSON.parse(JSON.stringify(details)) as PtcToolResult["details"],
	};

	const output = render(
		tool.renderResult(
			result,
			{ expanded: true, isPartial: false },
			THEME,
			createRenderContext(true),
		),
	);

	assert.match(output, new RegExp(NATIVE_READ_CONTENT));
});

test("ptc attachments cannot restore a result omitted from persisted details", () => {
	const tool = createTool();
	const rawDispatch: DispatchProgress = {
		id: 1,
		name: "read",
		args: { path: "note.txt" },
		status: "ok",
		result: {
			content: [{ type: "text", text: OMITTED_READ_CONTENT }],
			isError: false,
		},
	};
	const details = createSnapshotDetails(
		DESCRIPTION,
		[rawDispatch],
		undefined,
		OMITTED_RENDER_BUDGET_BYTES,
	);
	attachPtcRenderDispatches(details, [rawDispatch]);
	const result: PtcToolResult = {
		content: [{ type: "text", text: "ignored" }],
		details,
	};

	const output = render(
		tool.renderResult(
			result,
			{ expanded: true, isPartial: false },
			THEME,
			createRenderContext(true),
		),
	);

	assert.doesNotMatch(output, new RegExp(OMITTED_READ_CONTENT));
	assert.deepEqual(details.dispatches, [
		{
			id: rawDispatch.id,
			name: rawDispatch.name,
			args: rawDispatch.args,
			status: rawDispatch.status,
			renderOmitted: "budget",
		},
	]);
});

test("live write arguments use native rendering while restored redacted rows use a safe fallback", () => {
	const tool = createTool();
	const rawDispatch: DispatchProgress = {
		id: 1,
		name: "write",
		args: { path: "live.txt", content: LIVE_WRITE_CONTENT },
		status: "start",
	};
	const details = createDeltaDetails(DESCRIPTION, rawDispatch);
	attachPtcRenderDispatches(details, [rawDispatch]);
	let nativeRenderCalls = 0;
	const createDefinitions = () => ({
		write: {
			name: "write",
			renderCall: (args: { content?: string }) => {
				nativeRenderCalls += 1;
				return new Text(`${NATIVE_WRITE_RENDER_MARKER}: ${args.content ?? ""}`, 0, 0);
			},
		},
	});
	const liveContext = createRenderContext(false);
	Object.assign(liveContext, { createDefinitions });
	const liveOutput = render(
		tool.renderResult(
			{ content: [{ type: "text", text: "ignored" }], details },
			{ expanded: false, isPartial: true },
			THEME,
			liveContext,
		),
	);

	assert.match(liveOutput, new RegExp(NATIVE_WRITE_RENDER_MARKER));
	assert.match(liveOutput, new RegExp(LIVE_WRITE_CONTENT));
	assert.equal(nativeRenderCalls, 1);
	const restoredContext = createRenderContext(false);
	Object.assign(restoredContext, { createDefinitions });
	const restoredDetails = JSON.parse(JSON.stringify(details)) as PtcPartialResult["details"];
	const restoredOutput = render(
		tool.renderResult(
			{ content: [{ type: "text", text: "ignored" }], details: restoredDetails },
			{ expanded: false, isPartial: true },
			THEME,
			restoredContext,
		),
	);

	assert.match(restoredOutput, /write live\.txt/);
	assert.doesNotMatch(restoredOutput, new RegExp(NATIVE_WRITE_RENDER_MARKER));
	assert.doesNotMatch(restoredOutput, new RegExp(LIVE_WRITE_CONTENT));
	assert.equal(nativeRenderCalls, 1);
});

test("lossy live edit projections use a safe fallback when terminal render data is omitted", () => {
	const tool = createTool();
	const lossyEditCases = [
		[{ oldText: OVERSIZED_LIVE_EDIT_TEXT, newText: LOSSY_EDIT_REPLACEMENT }],
		Array.from({ length: LIVE_EDIT_ENTRY_LIMIT + 1 }, (_, index) => ({
			oldText: `${LOSSY_EDIT_OLD_PREFIX}-${index}`,
			newText: `${LOSSY_EDIT_NEW_PREFIX}-${index}`,
		})),
	];

	for (const edits of lossyEditCases) {
		const rawDispatch: DispatchProgress = {
			id: 1,
			name: "edit",
			args: { path: LOSSY_EDIT_PATH, edits },
			status: "ok",
			result: { content: [], isError: false },
		};
		const details = createDeltaDetails(DESCRIPTION, rawDispatch, OMITTED_RENDER_BUDGET_BYTES);
		attachPtcRenderDispatches(details, [rawDispatch]);
		let nativeRenderCalls = 0;
		const context = createRenderContext(false);
		Object.assign(context, {
			createDefinitions: () => ({
				edit: {
					name: "edit",
					renderShell: "self",
					renderCall: () => {
						nativeRenderCalls += 1;
						return new Text(NATIVE_EDIT_RENDER_MARKER, 0, 0);
					},
				},
			}),
		});
		const output = render(
			tool.renderResult(
				{ content: [{ type: "text", text: "ignored" }], details },
				{ expanded: false, isPartial: false },
				THEME,
				context,
			),
		);

		assert.equal(details.dispatches[0]?.renderOmitted, "budget");
		assert.match(output, /edit lossy\.txt/);
		assert.doesNotMatch(output, new RegExp(NATIVE_EDIT_RENDER_MARKER));
		assert.equal(nativeRenderCalls, 0);
	}
});

test("fresh outer rows reconstruct version 2 native output without hidden transport content", async () => {
	const details = JSON.parse(JSON.stringify(loadDispatchFixture("version-2-success.json")));
	const restored = createFreshOuter(details);
	const output = render(restored.component);

	assert.match(output, /read note\.txt/);
	assert.match(output, /restored read content/);
	assert.match(output, /edit src\/example\.ts/);
	assert.match(output, /-old/);
	assert.match(output, /\+new/);
	assert.match(output, /read image\.png/);
	assert.match(output, /image\/png/);
	assert.match(output, /\$ printf omitted/);
	assert.match(output, /preview-only output/);
	assert.doesNotMatch(output, new RegExp(RECONSTRUCTION_OUTER_MARKER));
	assert.ok(output.indexOf("read note.txt") < output.indexOf("edit src/example.ts"));
	assert.ok(output.indexOf("edit src/example.ts") < output.indexOf("read image.png"));
	const requestsAfterRestore = restored.renderRequests();
	await new Promise((resolve) => setTimeout(resolve, RECONSTRUCTION_IDLE_MS));
	assert.equal(restored.renderRequests(), requestsAfterRestore);
});

test("fresh outer rows preserve nested and outer error order after JSON reload", () => {
	const details = JSON.parse(JSON.stringify(loadDispatchFixture("version-2-errors.json")));
	const output = render(createFreshOuter(details, true).component);

	assert.match(output, /nested fixture failure/);
	assert.match(output, /outer fixture failure/);
	assert.ok(output.indexOf("nested fixture failure") < output.indexOf("outer fixture failure"));
	assert.doesNotMatch(output, new RegExp(RECONSTRUCTION_OUTER_MARKER));
});

test("fresh outer rows migrate historical IDs and surface malformed details", () => {
	const legacy = JSON.parse(JSON.stringify(loadDispatchFixture("legacy-no-id.json")));
	const malformed = JSON.parse(JSON.stringify(loadDispatchFixture("version-2-malformed.json")));
	const legacyOutput = render(createFreshOuter(legacy).component);
	const malformedOutput = render(createFreshOuter(malformed).component);

	assert.equal(legacyOutput.match(/read legacy\.txt/g)?.length, EXPECTED_SINGLE_RENDER_COUNT);
	assert.match(legacyOutput, /legacy restored output/);
	assert.match(legacyOutput, /\$ printf legacy/);
	assert.match(legacyOutput, /legacy bash output/);
	assert.match(legacyOutput, /display/);
	assert.match(malformedOutput, /read valid\.txt/);
	assert.match(malformedOutput, /valid row survives/);
	assert.match(malformedOutput, /display/);
});

test("ptc uses Pi native read ranges instead of custom status marks", () => {
	const tool = createTool();
	const result = resultWith([
		{
			id: 1,
			name: "read",
			args: { path: "package.json", offset: 251, limit: 250 },
			status: "ok",
		},
	]);

	const output = render(
		tool.renderResult(
			result,
			{ expanded: false, isPartial: false },
			THEME,
			createRenderContext(false),
		),
	);

	assert.match(output, /read package\.json:251-500/);
	assert.doesNotMatch(output, /✓/);
});

test("ptc preserves the failed native tool row when the outer execution fails", () => {
	const tool = createTool();
	const context = createRenderContext(false);
	const nestedFailure = resultWith([
		{
			id: 1,
			name: "bash",
			args: { command: "false" },
			status: "err",
			preview: "Command exited with code 1",
		},
	]);
	context.lastComponent = tool.renderResult(
		nestedFailure,
		{ expanded: false, isPartial: true },
		THEME,
		context,
	);
	context.isError = true;

	const output = render(
		tool.renderResult(
			{
				content: [{ type: "text", text: "ptc failed (runtime): tool failed" }],
				details: undefined,
			} as unknown as PtcToolResult,
			{ expanded: false, isPartial: false },
			THEME,
			context,
		),
	);

	assert.match(output, /\$ false/);
	assert.match(output, /Command exited with code 1/);
	assert.doesNotMatch(output, /Execution failed/);
});

test("ptc renderer owns public-contract rows without nested host components", () => {
	assert.doesNotMatch(RENDERER_SOURCE, /ToolExecutionComponent/);
	assert.doesNotMatch(RENDERER_SOURCE, /\bas TUI\b/);
});

test("ptc keeps stable rows across interleaved deltas, expansion, and resize", () => {
	const tool = createTool();
	const context = createRenderContext(false);
	const second = tool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: createDeltaDetails(DESCRIPTION, {
				id: 2,
				name: "bash",
				args: { command: "npm test" },
				status: "start",
			}),
		},
		{ expanded: false, isPartial: true },
		THEME,
		context,
	);
	const first = tool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: createDeltaDetails(DESCRIPTION, {
				id: 1,
				name: "read",
				args: { path: "package.json" },
				status: "start",
			}),
		},
		{ expanded: false, isPartial: true },
		THEME,
		context,
	);

	assert.equal(first, second);
	const collapsed = render(first, 80);
	assert.ok(collapsed.indexOf("read package.json") < collapsed.indexOf("$ npm test"));
	context.expanded = true;
	const expanded = tool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: createDeltaDetails(DESCRIPTION, {
				id: 1,
				name: "read",
				args: { path: "package.json" },
				status: "start",
			}),
		},
		{ expanded: true, isPartial: true },
		THEME,
		context,
	);
	assert.equal(expanded, first);
	assert.match(render(expanded, 60), /read package\.json/);
	assert.match(render(expanded, 140), /read package\.json/);
});

test("unchanged deltas and width-only renders do not rebuild native slots", () => {
	const tool = createTool();
	const context = createRenderContext(false);
	let callRenders = 0;
	let resultRenders = 0;
	Object.assign(context, {
		createDefinitions: () => ({
			read: {
				name: "read",
				renderCall: (_args: unknown, _theme: Theme, slot: { lastComponent?: Component }) => {
					callRenders += 1;
					return slot.lastComponent ?? new Text("read stable.txt", 0, 0);
				},
				renderResult: (
					_result: unknown,
					_options: unknown,
					_theme: Theme,
					slot: { lastComponent?: Component },
				) => {
					resultRenders += 1;
					return slot.lastComponent ?? new Text("done", 0, 0);
				},
			},
		}),
	});
	const update: PtcPartialResult = {
		content: [{ type: "text", text: "ignored" }],
		details: createDeltaDetails(DESCRIPTION, {
			id: 1,
			name: "read",
			args: { path: "stable.txt" },
			status: "ok",
			preview: "done",
		}),
	};

	const root = tool.renderResult(update, { expanded: false, isPartial: false }, THEME, context);
	tool.renderResult(update, { expanded: false, isPartial: false }, THEME, context);
	render(root, 60);
	render(root, 140);

	assert.equal(callRenders, EXPECTED_SINGLE_RENDER_COUNT);
	assert.equal(resultRenders, EXPECTED_SINGLE_RENDER_COUNT);
});

test("ptc root contains child rendering failures", () => {
	const tool = createTool();
	const context = createRenderContext(false);
	Object.assign(context, {
		createDefinitions: () => ({
			read: {
				name: "read",
				renderCall: () => ({
					invalidate: () => undefined,
					render: () => {
						throw new Error(CHILD_RENDER_FAILURE);
					},
				}),
			},
		}),
	});
	const output = render(
		tool.renderResult(
			{
				content: [{ type: "text", text: "ignored" }],
				details: createDeltaDetails(DESCRIPTION, {
					id: 1,
					name: "read",
					args: { path: "unsafe.txt" },
					status: "start",
				}),
			},
			{ expanded: false, isPartial: true },
			THEME,
			context,
		),
	);

	assert.match(output, /execution/);
	assert.match(output, new RegExp(CHILD_RENDER_FAILURE));
	assert.doesNotMatch(output, /unsafe\.txt/);
});

test("ptc sanitizes raw CSI, OSC, and APC across every display channel", () => {
	const tool = createTool();
	for (const control of RAW_CONTROL_SEQUENCES) {
		const controlled = `${RAW_VISIBLE_PREFIX}${control}${RAW_VISIBLE_SUFFIX}`;
		const context = createRenderContext(false, true);
		const output = renderRaw(
			tool.renderResult(
				{
					content: [{ type: "text", text: "ignored" }],
					details: {
						schemaVersion: 2,
						description: DESCRIPTION,
						mode: "snapshot",
						dispatches: [
							{
								id: 1,
								name: "read",
								args: { path: controlled },
								status: "err",
								preview: controlled,
							},
						],
						compatibilityError: controlled,
						executionError: controlled,
					},
				},
				{ expanded: false, isPartial: false },
				THEME,
				context,
			),
		);

		assert.equal(output.includes(control), false, JSON.stringify(output));
		assert.doesNotMatch(output, /unsafe-title|unsafe\.invalid|pi:unsafe/);
		assert.match(output, new RegExp(RAW_VISIBLE_TEXT));
	}
});

test("outer fallbacks and renderer diagnostics strip extended terminal controls", () => {
	const tool = createTool();
	const fallbackOutput = renderRaw(
		tool.renderResult(
			{
				content: [{ type: "text", text: EXTENDED_RENDER_CONTROL }],
				details: undefined,
			} as unknown as PtcToolResult,
			{ expanded: false, isPartial: false },
			THEME,
			createRenderContext(false, true),
		),
	);
	const diagnosticContext = createRenderContext(false);
	Object.assign(diagnosticContext, {
		createDefinitions: () => ({
			read: {
				name: "read",
				renderCall: () => {
					throw new Error(EXTENDED_RENDER_CONTROL);
				},
			},
		}),
	});
	const diagnosticOutput = renderRaw(
		tool.renderResult(
			{
				content: [{ type: "text", text: "ignored" }],
				details: createDeltaDetails(DESCRIPTION, {
					id: 1,
					name: "read",
					args: { path: "safe.txt" },
					status: "start",
				}),
			},
			{ expanded: false, isPartial: true },
			THEME,
			diagnosticContext,
		),
	);

	for (const output of [fallbackOutput, diagnosticOutput]) {
		assert.equal(output.includes("\u001b"), false);
		assert.equal(output.includes("\u0007"), false);
		assert.equal(output.includes("\u009b"), false);
		assert.match(output, new RegExp(RAW_VISIBLE_TEXT));
	}
});

test("constructor failures stay inside the real outer tool renderer", () => {
	const tool = createTool();
	const hostileTool = {
		...tool,
		renderResult(
			result: PtcPartialResult | PtcToolResult,
			options: ToolRenderResultOptions,
			theme: Theme,
			context: PtcRenderContext,
		) {
			return tool.renderResult(result, options, theme, {
				...context,
				createDefinitions: () => {
					throw new Error(CONSTRUCTOR_FAILURE);
				},
			});
		},
	};
	const outer = new ToolExecutionComponent(
		"ptc",
		RENDER_TOOL_CALL_ID,
		{ code: OUTER_FALLBACK_MARKER, description: DESCRIPTION },
		{ showImages: false },
		hostileTool as unknown as HostToolDefinition,
		{ requestRender: () => undefined } as TUI,
		process.cwd(),
	);
	outer.markExecutionStarted();
	outer.setArgsComplete();
	outer.updateResult(
		{
			content: [{ type: "text", text: OUTER_FALLBACK_MARKER }],
			details: createSnapshotDetails(DESCRIPTION, [
				{ id: 1, name: "read", args: { path: "safe.txt" }, status: "start" },
			]),
			isError: false,
		},
		false,
	);
	const output = render(outer);

	assert.match(output, new RegExp(CONSTRUCTOR_FAILURE));
	assert.doesNotMatch(output, new RegExp(OUTER_FALLBACK_MARKER));
});

test("call and result slot failures become sanitized diagnostics", () => {
	const tool = createTool();
	for (const stage of ["call", "result"] as const) {
		const context = createRenderContext(false);
		const failure = stage === "call" ? CALL_RENDER_FAILURE : RESULT_RENDER_FAILURE;
		Object.assign(context, {
			createDefinitions: () => ({
				read: {
					name: "read",
					renderCall: () => {
						if (stage === "call") throw new Error(failure);
						return new Text("safe", 0, 0);
					},
					renderResult: () => {
						throw new Error(failure);
					},
				},
			}),
		});
		const output = renderRaw(
			tool.renderResult(
				{
					content: [{ type: "text", text: "ignored" }],
					details: createDeltaDetails(DESCRIPTION, {
						id: 1,
						name: "read",
						args: { path: "safe.txt" },
						status: "ok",
						preview: "done",
					}),
				},
				{ expanded: false, isPartial: false },
				THEME,
				context,
			),
		);

		assert.match(output, /execution/);
		assert.match(output, new RegExp(RAW_VISIBLE_TEXT));
		assert.equal(output.includes("\u001b"), false);
		assert.equal(output.includes("\u0007"), false);
	}
});

test("slot and invalidate failures become bounded diagnostics", () => {
	const tool = createTool();
	let nestedInvalidate: (() => void) | undefined;
	const context = createRenderContext(false);
	Object.assign(context, {
		createDefinitions: () => ({
			read: {
				name: "read",
				renderCall: (_args: unknown, _theme: Theme, slot: { invalidate(): void }) => {
					nestedInvalidate = slot.invalidate;
					return {
						invalidate: () => {
							throw new Error(INVALIDATE_FAILURE);
						},
						render: () => ["safe"],
					};
				},
			},
		}),
	});
	const root = tool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: createDeltaDetails(DESCRIPTION, {
				id: 1,
				name: "read",
				args: { path: "safe.txt" },
				status: "start",
			}),
		},
		{ expanded: false, isPartial: true },
		THEME,
		context,
	);

	assert.doesNotThrow(() => nestedInvalidate?.());
	assert.match(render(root), new RegExp(INVALIDATE_FAILURE));

	let outerInvalidate: (() => void) | undefined;
	const outerContext = {
		...createRenderContext(false),
		invalidate: () => {
			throw new Error(OUTER_INVALIDATE_FAILURE);
		},
	};
	Object.assign(outerContext, {
		createDefinitions: () => ({
			read: {
				name: "read",
				renderCall: (_args: unknown, _theme: Theme, slot: { invalidate(): void }) => {
					outerInvalidate = slot.invalidate;
					return new Text("safe", 0, 0);
				},
			},
		}),
	});
	const outerRoot = tool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: createDeltaDetails(DESCRIPTION, {
				id: 1,
				name: "read",
				args: { path: "safe.txt" },
				status: "start",
			}),
		},
		{ expanded: false, isPartial: true },
		THEME,
		outerContext,
	);
	assert.doesNotThrow(() => outerInvalidate?.());
	assert.match(render(outerRoot), new RegExp(OUTER_INVALIDATE_FAILURE));
});

test("image-only results keep a textual fallback when the terminal has no image protocol", () => {
	const tool = createTool();
	const context = {
		...createRenderContext(false),
		showImages: true,
	};
	Object.assign(context, {
		createDefinitions: () => ({
			read: {
				name: "read",
				renderCall: () => new Text("read image.png", 0, 0),
				renderResult: () => new Text("", 0, 0),
			},
		}),
		createImage: () => new Text(IMAGE_FALLBACK_TEXT, 0, 0),
		getImageProtocol: () => null,
	});
	const output = render(
		tool.renderResult(
			{
				content: [{ type: "text", text: "ignored" }],
				details: createDeltaDetails(DESCRIPTION, {
					id: 1,
					name: "read",
					args: { path: "image.png" },
					status: "ok",
					result: {
						content: [{ type: "image", data: PNG_IMAGE_DATA, mimeType: "image/png" }],
						isError: false,
					},
				}),
			},
			{ expanded: false, isPartial: false },
			THEME,
			context,
		),
	);

	assert.match(output, new RegExp(IMAGE_FALLBACK_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("theme invalidation rebuilds native slots without retiring current callbacks", () => {
	const tool = createTool();
	let themeText = ORIGINAL_THEME_TEXT;
	let firstInvalidate: (() => void) | undefined;
	let outerInvalidations = 0;
	const mutableTheme = {
		...THEME,
		fg: (_color: string, _text: string) => themeText,
	} as Theme;
	const context = {
		...createRenderContext(false),
		invalidate: () => {
			outerInvalidations += 1;
		},
	};
	Object.assign(context, {
		createDefinitions: () => ({
			read: {
				name: "read",
				renderCall: (
					_args: unknown,
					theme: Theme,
					slot: { invalidate(): void; lastComponent?: Component },
				) => {
					firstInvalidate ??= slot.invalidate;
					const text = slot.lastComponent instanceof Text ? slot.lastComponent : new Text("", 0, 0);
					text.setText(theme.fg("toolTitle", "read themed.txt"));
					return text;
				},
			},
		}),
	});
	const root = tool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: createDeltaDetails(DESCRIPTION, {
				id: 1,
				name: "read",
				args: { path: "themed.txt" },
				status: "start",
			}),
		},
		{ expanded: false, isPartial: true },
		mutableTheme,
		context,
	);

	assert.match(render(root), new RegExp(ORIGINAL_THEME_TEXT));
	themeText = UPDATED_THEME_TEXT;
	root.invalidate();
	assert.match(render(root), new RegExp(UPDATED_THEME_TEXT));
	const invalidationsBeforeCallback = outerInvalidations;
	firstInvalidate?.();
	assert.equal(outerInvalidations, invalidationsBeforeCallback + 1);
});

test("partial rebuilds keep the active native renderer callback live", () => {
	const tool = createTool();
	let activeCallback: (() => void) | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;
	let outerInvalidations = 0;
	let resultRenders = 0;
	let root: Component | undefined;
	const context = {
		...createRenderContext(false),
		invalidate: () => {
			outerInvalidations += 1;
			root?.invalidate();
		},
	};
	Object.assign(context, {
		createDefinitions: () => ({
			bash: {
				name: "bash",
				renderCall: () => new Text("bash", 0, 0),
				renderResult: (
					_result: unknown,
					_options: unknown,
					_theme: Theme,
					slot: { invalidate(): void; state: Record<string, unknown> },
				) => {
					resultRenders += 1;
					if (!slot.state.interval) {
						activeCallback = slot.invalidate;
						interval = setInterval(() => undefined, CALLBACK_TEST_INTERVAL_MS);
						slot.state.interval = interval;
					}
					return new Text(`working-${resultRenders}`, 0, 0);
				},
			},
		}),
	});
	try {
		for (const preview of ["first", "second"]) {
			root = tool.renderResult(
				{
					content: [{ type: "text", text: "ignored" }],
					details: createDeltaDetails(DESCRIPTION, {
						id: 1,
						name: "bash",
						args: { command: "sleep 1" },
						status: "start",
						preview,
					}),
				},
				{ expanded: false, isPartial: true },
				THEME,
				context,
			);
		}

		const invalidationsBeforeCallback = outerInvalidations;
		const rendersBeforeCallback = resultRenders;
		activeCallback?.();
		assert.equal(outerInvalidations, invalidationsBeforeCallback + 1);
		assert.equal(resultRenders, rendersBeforeCallback + 1);
	} finally {
		if (interval) clearInterval(interval);
	}
});

test("image conversion is deduplicated and bound to the current row generation", async () => {
	const tool = createTool();
	let resolveConversion!: (value: { data: string; mimeType: string }) => void;
	const conversion = new Promise<{ data: string; mimeType: string }>((resolve) => {
		resolveConversion = resolve;
	});
	let conversionCalls = 0;
	let invalidations = 0;
	const imageWidths: number[] = [];
	const context = {
		...createRenderContext(false),
		invalidate: () => {
			invalidations += 1;
		},
		showImages: true,
	};
	Object.assign(context, {
		convertImage: async () => {
			conversionCalls += 1;
			return await conversion;
		},
		createDefinitions: () => ({
			read: {
				name: "read",
				renderCall: () => new Text("read image.jpg", 0, 0),
				renderResult: () => new Text("", 0, 0),
			},
		}),
		createImage: (_data: string, _mimeType: string, maxWidthCells: number) => {
			imageWidths.push(maxWidthCells);
			return new Text(`image:${maxWidthCells}`, 0, 0);
		},
		getImageProtocol: () => "kitty",
	});
	const imageResult = {
		content: [{ type: "image", data: JPEG_IMAGE_DATA, mimeType: "image/jpeg" }],
		isError: false,
	};
	const partial: PtcPartialResult = {
		content: [{ type: "text", text: "ignored" }],
		details: createDeltaDetails(DESCRIPTION, {
			id: 1,
			name: "read",
			args: { path: "image.jpg" },
			status: "start",
			result: imageResult,
		}),
	};
	const root = tool.renderResult(partial, { expanded: false, isPartial: true }, THEME, context);
	tool.renderResult(partial, { expanded: false, isPartial: true }, THEME, context);
	tool.renderResult(
		{
			...partial,
			details: createDeltaDetails(DESCRIPTION, {
				id: 1,
				name: "read",
				args: { path: "image.jpg" },
				status: "ok",
				result: imageResult,
			}),
		},
		{ expanded: false, isPartial: false },
		THEME,
		context,
	);

	assert.equal(conversionCalls, 1);
	resolveConversion({ data: CONVERTED_IMAGE_DATA, mimeType: "image/png" });
	await conversion;
	await Promise.resolve();
	assert.equal(invalidations, 1);
	assert.match(render(root, IMAGE_RENDER_WIDTH), new RegExp(`image:${IMAGE_RENDER_WIDTH}`));
	assert.match(render(root, IMAGE_RESIZED_WIDTH), new RegExp(`image:${IMAGE_RESIZED_WIDTH}`));
	assert.deepEqual(imageWidths, [IMAGE_RENDER_WIDTH, IMAGE_RESIZED_WIDTH]);

	let resolveStale!: (value: { data: string; mimeType: string }) => void;
	const staleConversion = new Promise<{ data: string; mimeType: string }>((resolve) => {
		resolveStale = resolve;
	});
	let staleInvalidations = 0;
	const staleContext = {
		...createRenderContext(false),
		invalidate: () => {
			staleInvalidations += 1;
		},
		showImages: true,
	};
	Object.assign(staleContext, {
		convertImage: async () => await staleConversion,
		createDefinitions: () => ({
			read: {
				name: "read",
				renderCall: () => new Text("read image", 0, 0),
				renderResult: () => new Text("", 0, 0),
			},
		}),
		createImage: () => new Text("image", 0, 0),
		getImageProtocol: () => "kitty",
	});
	tool.renderResult(partial, { expanded: false, isPartial: true }, THEME, staleContext);
	tool.renderResult(
		{
			...partial,
			details: createDeltaDetails(DESCRIPTION, {
				id: 1,
				name: "read",
				args: { path: "replacement.png" },
				status: "ok",
				result: {
					content: [{ type: "image", data: PNG_IMAGE_DATA, mimeType: "image/png" }],
					isError: false,
				},
			}),
		},
		{ expanded: false, isPartial: false },
		THEME,
		staleContext,
	);
	resolveStale({ data: CONVERTED_IMAGE_DATA, mimeType: "image/png" });
	await staleConversion;
	await Promise.resolve();
	assert.equal(staleInvalidations, 0);
});

test("ptc renders nested and outer failures independently", () => {
	const tool = createTool();
	const context = createRenderContext(false, true);
	const output = render(
		tool.renderResult(
			{
				content: [{ type: "text", text: "ptc failed (runtime): outer failure" }],
				details: createSnapshotDetails(
					DESCRIPTION,
					[
						{
							id: 1,
							name: "bash",
							args: { command: "false" },
							status: "err",
							preview: "nested failure",
						},
					],
					"outer failure",
				),
			},
			{ expanded: false, isPartial: false },
			THEME,
			context,
		),
	);

	assert.match(output, /nested failure/);
	assert.match(output, /outer failure/);
	assert.match(output, /execution/);
});

test("ptc strips terminal controls from nested args, previews, and execution errors", () => {
	const tool = createTool();
	const controlled = `${ANSI_RED}unsafe${ANSI_RESET}`;
	const result = resultWith([
		{
			id: 1,
			name: "bash",
			args: { command: controlled },
			status: "err",
			preview: controlled,
		},
	]);
	const nested = render(
		tool.renderResult(
			result,
			{ expanded: false, isPartial: false },
			THEME,
			createRenderContext(false),
		),
	);
	const executionError = render(
		tool.renderResult(
			{
				content: [{ type: "text", text: controlled }],
				details: undefined,
			} as unknown as PtcToolResult,
			{ expanded: false, isPartial: false },
			THEME,
			createRenderContext(false, true),
		),
	);

	assert.equal(nested.includes(ANSI_RED), false);
	assert.equal(nested.includes(ANSI_RESET), false);
	assert.equal(executionError.includes(ANSI_RED), false);
	assert.equal(executionError.includes(ANSI_RESET), false);
	assert.match(executionError, /execution/);
	assert.match(executionError, /unsafe/);
});
