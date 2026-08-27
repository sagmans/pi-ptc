import { strict as assert } from "node:assert";

import { initTheme, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, Text } from "@earendil-works/pi-tui";

import { SHIPPED_PTC_CONFIG } from "../src/config.ts";
import { createDeltaDetails, createSnapshotDetails } from "../src/dispatch-details.ts";
import type { PtcRenderContext } from "../src/renderer.ts";
import { createPtcTool, type PtcPartialResult, type PtcToolResult } from "../src/transport.ts";

const DESCRIPTION = "exercise Bun renderer bindings";
const RENDER_WIDTH = 100;
const RAW_TERMINAL_SEQUENCE = "\u001b[2J";
const RAW_PATH = `before${RAW_TERMINAL_SEQUENCE}after.txt`;
const SANITIZED_PATH = "beforeafter.txt";
const FINAL_READ_TEXT = "BUN_NATIVE_READ_RESULT";
const NESTED_ERROR = "BUN_NESTED_ERROR";
const OUTER_ERROR = "BUN_OUTER_ERROR";
const HIDDEN_OUTER_TEXT = "BUN_HIDDEN_OUTER_TEXT";
const RESTORED_TEXT = "BUN_JSON_RESTORED_RESULT";
const SMALL_SCALE_DISPATCHES = 50;
const LARGE_SCALE_DISPATCHES = SHIPPED_PTC_CONFIG.maxDispatches;
const EXPECTED_LINEAR_UPDATE_RATIO = 2;
const UPDATE_RATIO_TOLERANCE = 0.05;
const FIRST_DISPATCH_ID = 1;

const THEME = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

initTheme(undefined, false);

function createTool() {
	return createPtcTool({
		timeoutMs: SHIPPED_PTC_CONFIG.timeoutMs,
		maxDispatches: SHIPPED_PTC_CONFIG.maxDispatches,
		maxOutputBytes: SHIPPED_PTC_CONFIG.maxOutputBytes,
		maxOutputLines: SHIPPED_PTC_CONFIG.maxOutputLines,
		createBindings: () => ({}),
	});
}

function createContext(
	toolCallId: string,
	createDefinitions?: PtcRenderContext["createDefinitions"],
): PtcRenderContext {
	return {
		toolCallId,
		cwd: process.cwd(),
		state: {},
		invalidate: () => undefined,
		lastComponent: undefined,
		expanded: true,
		showImages: false,
		isError: false,
		createDefinitions,
	};
}

function renderRaw(component: Component): string {
	return component.render(RENDER_WIDTH).join("\n");
}

function renderText(component: Component): string {
	return component
		.render(RENDER_WIDTH)
		.map((line) => stripTerminalSequences(line).trim())
		.filter((line) => line.length > 0)
		.join("\n");
}

function partial(details: PtcPartialResult["details"]): PtcPartialResult {
	return {
		content: [{ type: "text", text: HIDDEN_OUTER_TEXT }],
		details,
	};
}

function final(details: PtcToolResult["details"]): PtcToolResult {
	return {
		content: [{ type: "text", text: HIDDEN_OUTER_TEXT }],
		details,
	};
}

function measureScale(dispatchCount: number): { renderCalls: number; retainedRows: number } {
	const tool = createTool();
	let renderCalls = 0;
	const context = createContext(`scale-${dispatchCount}`, () => ({
		read: {
			name: "read",
			renderCall: (args: { path: string }) => {
				renderCalls += 1;
				return new Text(`row:${args.path}`, 0, 0);
			},
		} as unknown as ToolDefinition,
	}));
	let root: Component | undefined;
	for (let id = FIRST_DISPATCH_ID; id <= dispatchCount; id += 1) {
		root = tool.renderResult(
			partial(
				createDeltaDetails(DESCRIPTION, {
					id,
					name: "read",
					args: { path: `file-${id}.txt` },
					status: "start",
				}),
			),
			{ expanded: true, isPartial: true },
			THEME,
			context,
		);
	}
	assert.ok(root);
	const retainedRows = renderText(root)
		.split("\n")
		.filter((line) => line.startsWith("row:file-")).length;
	return { renderCalls, retainedRows };
}

const tool = createTool();
const liveContext = createContext("bun-live");
const liveRoot = tool.renderResult(
	partial(
		createDeltaDetails(DESCRIPTION, {
			id: FIRST_DISPATCH_ID,
			name: "read",
			args: { path: RAW_PATH },
			status: "start",
		}),
	),
	{ expanded: true, isPartial: true },
	THEME,
	liveContext,
);
const rawStart = renderRaw(liveRoot);
assert.equal(rawStart.includes(RAW_TERMINAL_SEQUENCE), false);
assert.match(stripTerminalSequences(rawStart), new RegExp(SANITIZED_PATH));

const finalRoot = tool.renderResult(
	partial(
		createDeltaDetails(DESCRIPTION, {
			id: FIRST_DISPATCH_ID,
			name: "read",
			args: { path: RAW_PATH },
			status: "ok",
			result: {
				content: [{ type: "text", text: FINAL_READ_TEXT }],
				isError: false,
			},
		}),
	),
	{ expanded: true, isPartial: false },
	THEME,
	liveContext,
);
assert.equal(finalRoot, liveRoot);
assert.match(renderText(finalRoot), new RegExp(FINAL_READ_TEXT));

liveContext.isError = true;
const errorRoot = tool.renderResult(
	final(
		createSnapshotDetails(
			DESCRIPTION,
			[
				{
					id: FIRST_DISPATCH_ID + 1,
					name: "bash",
					args: { command: "false" },
					status: "err",
					preview: NESTED_ERROR,
				},
			],
			OUTER_ERROR,
		),
	),
	{ expanded: true, isPartial: false },
	THEME,
	liveContext,
);
const errorOutput = renderText(errorRoot);
assert.match(errorOutput, new RegExp(NESTED_ERROR));
assert.match(errorOutput, new RegExp(OUTER_ERROR));
assert.ok(errorOutput.indexOf(NESTED_ERROR) < errorOutput.indexOf(OUTER_ERROR));
assert.doesNotMatch(errorOutput, new RegExp(HIDDEN_OUTER_TEXT));

const restoredContext = createContext("bun-restored");
const restoredDetails = JSON.parse(
	JSON.stringify(
		createSnapshotDetails(DESCRIPTION, [
			{
				id: FIRST_DISPATCH_ID,
				name: "read",
				args: { path: "restored.txt" },
				status: "ok",
				result: {
					content: [{ type: "text", text: RESTORED_TEXT }],
					isError: false,
				},
			},
		]),
	),
) as PtcToolResult["details"];
const restoredRoot = tool.renderResult(
	final(restoredDetails),
	{ expanded: true, isPartial: false },
	THEME,
	restoredContext,
);
assert.match(renderText(restoredRoot), new RegExp(RESTORED_TEXT));

const smallScale = measureScale(SMALL_SCALE_DISPATCHES);
const largeScale = measureScale(LARGE_SCALE_DISPATCHES);
const updateRatio = largeScale.renderCalls / smallScale.renderCalls;
assert.equal(smallScale.retainedRows, SMALL_SCALE_DISPATCHES);
assert.equal(largeScale.retainedRows, LARGE_SCALE_DISPATCHES);
assert.ok(largeScale.retainedRows <= SHIPPED_PTC_CONFIG.maxDispatches);
assert.ok(
	Math.abs(updateRatio - EXPECTED_LINEAR_UPDATE_RATIO) <= UPDATE_RATIO_TOLERANCE,
	`expected update ratio near ${EXPECTED_LINEAR_UPDATE_RATIO}, got ${updateRatio}`,
);

console.log(
	JSON.stringify({
		ok: true,
		live: { sanitizedPath: SANITIZED_PATH, result: FINAL_READ_TEXT },
		errors: { nested: NESTED_ERROR, outer: OUTER_ERROR },
		restored: RESTORED_TEXT,
		scaling: { smallScale, largeScale, updateRatio },
	}),
);
