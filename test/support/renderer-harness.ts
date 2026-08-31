import { readFileSync } from "node:fs";

import {
	initTheme,
	type Theme,
	ToolExecutionComponent,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";

import { SHIPPED_PTC_CONFIG } from "../../src/config.ts";
import { createSnapshotDetails } from "../../src/dispatch-details.ts";
import type { PtcDefinitionRegistry, PtcRenderContext } from "../../src/renderer.ts";
import type { ToolCatalogEntry } from "../../src/tool-catalog.ts";
import {
	createPtcTool,
	type PtcParams,
	type PtcPartialResult,
	type PtcToolResult,
} from "../../src/transport.ts";

export const ANSI_RED = "\u001b[31m";
export const ANSI_RESET = "\u001b[0m";
export const DESCRIPTION = "inspect package";
export const PROGRAM = "return 1;";
export const RENDER_TOOL_CALL_ID = "render-call";
export const RENDER_WIDTH = 120;
export const IMAGE_RENDER_WIDTH = 73;
export const IMAGE_RESIZED_WIDTH = 41;
export const EXPECTED_SINGLE_RENDER_COUNT = 1;
export const RECONSTRUCTION_IDLE_MS = 30;
export const RECONSTRUCTION_OUTER_MARKER = "HIDDEN_RECONSTRUCTION_OUTER";
export const RENDERER_SOURCE = readFileSync(
	new URL("../../src/renderer.ts", import.meta.url),
	"utf8",
);
export const NATIVE_READ_CONTENT = "NATIVE_READ_CONTENT";
export const OMITTED_READ_CONTENT = "OMITTED_READ_CONTENT";
export const OMITTED_RENDER_BUDGET_BYTES = 1;
export const LIVE_WRITE_CONTENT = "bounded live content";
export const NATIVE_WRITE_RENDER_MARKER = "native write renderer";
export const NATIVE_EDIT_RENDER_MARKER = "native edit renderer";
export const LIVE_EDIT_ENTRY_LIMIT = 8;
export const LIVE_EDIT_TEXT_LIMIT_BYTES = 192;
export const OVERSIZED_LIVE_EDIT_TEXT = "x".repeat(LIVE_EDIT_TEXT_LIMIT_BYTES + 1);
export const LOSSY_EDIT_PATH = "lossy.txt";
export const LOSSY_EDIT_REPLACEMENT = "replacement";
export const LOSSY_EDIT_OLD_PREFIX = "old";
export const LOSSY_EDIT_NEW_PREFIX = "new";
export const JPEG_IMAGE_DATA = "aW1hZ2U=";
export const PNG_IMAGE_DATA = "cG5n";
export const CONVERTED_IMAGE_DATA = "Y29udmVydGVk";
export const IMAGE_FALLBACK_TEXT = "[Image: image/png]";
export const ORIGINAL_THEME_TEXT = "ORIGINAL_THEME";
export const UPDATED_THEME_TEXT = "UPDATED_THEME";
export const CALLBACK_TEST_INTERVAL_MS = 60_000;
export const CHILD_RENDER_FAILURE = "child render failure";
export const CAPTURED_CORE_RENDER_MARKER = "captured core renderer";
export const CONSTRUCTOR_FAILURE = "constructor failure";
export const INVALIDATE_FAILURE = "invalidate failure";
export const OUTER_INVALIDATE_FAILURE = "outer invalidate failure";
export const OUTER_FALLBACK_MARKER = "OUTER_PROGRAM_MARKER";
export const RAW_VISIBLE_PREFIX = "before";
export const RAW_VISIBLE_SUFFIX = "after";
export const RAW_VISIBLE_TEXT = `${RAW_VISIBLE_PREFIX}${RAW_VISIBLE_SUFFIX}`;
export const CALL_RENDER_FAILURE = `${RAW_VISIBLE_PREFIX}\u001b[2J${RAW_VISIBLE_SUFFIX}`;
export const RESULT_RENDER_FAILURE = `${RAW_VISIBLE_PREFIX}\u001b]0;unsafe\u0007${RAW_VISIBLE_SUFFIX}`;
export const EXTENDED_RENDER_CONTROL = `${RAW_VISIBLE_PREFIX}\u001b[?1049h\u001bc\u0007\u009b31m\u001bPpayload\u001b\\${RAW_VISIBLE_SUFFIX}`;
export const RAW_CONTROL_SEQUENCES = [
	"\u001b[2J",
	"\u001b[H",
	"\u001b]0;unsafe-title\u0007",
	"\u001b]8;;https://unsafe.invalid\u0007\u001b]8;;\u0007",
	"\u001b_pi:unsafe\u0007",
] as const;
export const CONTROLLED_TOOL_NAME_CASES = [
	"before\u001b[31mafter",
	"before\u001b]0;unsafe-title\u0007after",
	"before\u001b_payload\u001b\\after",
	"before\nafter",
	"before\u009b31mafter",
] as const;
export const OVERSIZED_TOOL_NAME = "tool-name".repeat(1_000);
export const MAX_FALLBACK_RENDER_BYTES = 1_024;
export const DEEP_PROTOTYPE_LEVELS = 256;
export const MAX_EXPECTED_PROTOTYPE_TRAPS = 64;
export const LIMITS = {
	timeoutMs: 2000,
	maxDispatches: SHIPPED_PTC_CONFIG.maxDispatches,
	maxOutputBytes: 51200,
	maxOutputLines: 2000,
};

export const THEME = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

initTheme(undefined, false);

export type HostToolDefinition = NonNullable<
	ConstructorParameters<typeof ToolExecutionComponent>[4]
>;

export type RenderableTool = ReturnType<typeof createPtcTool> & {
	renderShell: "self";
	renderCall: (args: PtcParams, theme: Theme, context: PtcRenderContext) => Component;
	renderResult: (
		result: PtcPartialResult | PtcToolResult,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: PtcRenderContext,
	) => Component;
};

export function createTool(): RenderableTool {
	return createPtcTool({
		...LIMITS,
		createBindings: () => ({}),
	}) as RenderableTool;
}

export function createRenderContext(expanded: boolean, isError = false): PtcRenderContext {
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

export function render(component: Component, width = RENDER_WIDTH): string {
	return component
		.render(width)
		.map((line) => stripTerminalSequences(line).trim())
		.filter((line) => line.length > 0)
		.join("\n");
}

export function renderRaw(component: Component, width = RENDER_WIDTH): string {
	return component.render(width).join("\n");
}

export function loadDispatchFixture(name: string): unknown {
	return JSON.parse(
		readFileSync(new URL(`../fixtures/dispatch-details/${name}`, import.meta.url), "utf8"),
	);
}

export function createFreshOuter(
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

export function resultWith(dispatches: PtcToolResult["details"]["dispatches"]): PtcToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify({ logs: [], result: { hidden: true } }) }],
		details: createSnapshotDetails(DESCRIPTION, dispatches),
	};
}

export function definitionRegistry(definitions: Record<string, unknown>): PtcDefinitionRegistry {
	return new Map(Object.entries(definitions)) as PtcDefinitionRegistry;
}

export function rendererCatalogEntry(name: string, definition: unknown): ToolCatalogEntry {
	return {
		name,
		definition,
		executable: {
			parameters: {},
			async execute() {
				return { content: [] };
			},
		},
	};
}
