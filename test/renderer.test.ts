import { strict as assert } from "node:assert";
import test from "node:test";

import {
	initTheme,
	type Theme,
	ToolExecutionComponent,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";

import type { DispatchProgress } from "../src/bridge.ts";
import { SHIPPED_PTC_CONFIG } from "../src/config.ts";
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
const EXPECTED_SINGLE_RENDER_COUNT = 1;
const LIMITS = {
	timeoutMs: 2000,
	maxDispatches: SHIPPED_PTC_CONFIG.maxDispatches,
	maxOutputBytes: 51200,
	maxOutputLines: 2000,
};

const THEME = {
	fg: (_color: string, text: string) => text,
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

function resultWith(dispatches: PtcToolResult["details"]["dispatches"]): PtcToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify({ logs: [], result: { hidden: true } }) }],
		details: { description: DESCRIPTION, dispatches },
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
		details: {
			description: DESCRIPTION,
			dispatches: [
				{ id: 1, name: "read", args: { path: "package.json" }, status: "start" },
				{ id: 2, name: "bash", args: { command: "npm test" }, status: "start" },
			],
		},
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

test("ptc gives native renderers complete results without serializing binding values", () => {
	const tool = createTool();
	const secret = "NATIVE_READ_CONTENT";
	const result = resultWith([
		{
			id: 1,
			name: "read",
			args: { path: "note.txt" },
			status: "ok",
		},
	]);
	attachPtcRenderDispatches(result.details, [
		{
			id: 1,
			name: "read",
			args: { path: "note.txt" },
			status: "ok",
			result: {
				content: [{ type: "text", text: secret }],
				details: undefined,
				isError: false,
			},
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

	assert.match(output, new RegExp(secret));
	assert.equal(JSON.stringify(result.details).includes(secret), false);
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

test("ptc does not re-enter the outer renderer when a nested row requests display", () => {
	const tool = createTool();
	const dispatch: DispatchProgress = {
		id: 1,
		name: "read",
		args: { path: "package.json" },
		status: "ok",
		result: {
			content: [{ type: "text", text: "nested content" }],
			details: undefined,
			isError: false,
		},
	};
	const result = resultWith([{ id: 1, name: "read", args: dispatch.args, status: "ok" }]);
	attachPtcRenderDispatches(result.details, [dispatch]);
	const outer = new ToolExecutionComponent(
		"ptc",
		RENDER_TOOL_CALL_ID,
		{ code: PROGRAM, description: DESCRIPTION },
		{ showImages: false },
		tool as unknown as HostToolDefinition,
		{ requestRender: () => undefined } as TUI,
		process.cwd(),
	);
	outer.markExecutionStarted();
	outer.setArgsComplete();
	outer.updateResult({ ...result, isError: false }, false);

	const matches = render(outer).match(/read package\.json/g);
	assert.equal(matches?.length, EXPECTED_SINGLE_RENDER_COUNT);
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
