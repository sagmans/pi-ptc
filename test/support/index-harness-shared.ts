import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import type { ExtensionContext } from "../../src/host.ts";
import type { PtcRenderContext } from "../../src/renderer.ts";
import type { PtcParams, PtcPartialResult, PtcToolResult } from "../../src/transport.ts";

export const FAILURE_TOOL_CALL_ID = "ptc-failure";
export const SHUTDOWN_TOOL_CALL_ID = "ptc-shutdown";
export const MISSING_TOOL_CALL_ID = "ptc-missing";
export const SHARED_TOOL_CALL_ID = "ptc-shared";
export const FAILURE_DESCRIPTION = "fail after nested dispatch";
export const FIRST_FAILURE_DESCRIPTION = "first installer failure";
export const SECOND_FAILURE_DESCRIPTION = "second installer failure";
export const OUTER_FAILURE_MESSAGE = "planned outer failure";
export const FIRST_OUTER_FAILURE_MESSAGE = "first planned failure";
export const SECOND_OUTER_FAILURE_MESSAGE = "second planned failure";
export const FAILURE_PROGRAM = `await tools.ls({ path: "." }); throw new Error("${OUTER_FAILURE_MESSAGE}");`;
export const FIRST_FAILURE_PROGRAM = `throw new Error("${FIRST_OUTER_FAILURE_MESSAGE}");`;
export const SECOND_FAILURE_PROGRAM = `throw new Error("${SECOND_OUTER_FAILURE_MESSAGE}");`;

export const INERT_RUNTIME_DIAGNOSTIC = "Unsupported Pi runtime version: test mismatch";
export const REAL_CHARACTERIZATION_DIRECTORY_PREFIX = "pi-ptc-missing-capture-";
export const REAL_INITIAL_OWNER_DIRECTORY_PREFIX = "pi-ptc-initial-owner-";
export const REAL_LATE_OWNER_DIRECTORY_PREFIX = "pi-ptc-late-owner-";
export const REAL_RELOAD_DIRECTORY_PREFIX = "pi-ptc-reload-shutdown-";
export const COMPETING_TOOL_NAME = "fabric_exec";
export const LATE_OWNER_SYSTEM_PROMPT = "late owner system prompt";
export const LATE_OWNER_TOOL_CALL_ID = "late-owner-tool-call";
export const SHUTDOWN_REFRESH_TOOL_NAME = "shutdown_refresh_probe";
export const CUSTOM_RUNTIME_TOOL_NAME = "mcp.weather";
export const INACTIVE_RUNTIME_TOOL_NAME = "inactive_runtime";
export const VISUAL_RUNTIME_TOOL_NAME = "visual_runtime";
export const TEST_THEME = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

export type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;
export type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
export type RegisteredTool = {
	name: string;
	execute(
		toolCallId: string,
		params: PtcParams,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: PtcPartialResult) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<PtcToolResult>;
};

export function tempPaths() {
	const dir = mkdtempSync(join(tmpdir(), "pi-ptc-index-"));
	return {
		projectFile: join(dir, "project", "ptc.json"),
		userFile: join(dir, "user", "ptc.json"),
	};
}

export function parseOuterResult(result: PtcToolResult): Record<string, unknown> {
	return JSON.parse(result.content[0]?.text ?? "") as Record<string, unknown>;
}

export function renderToolResult(
	tool: RegisteredTool,
	result: PtcToolResult,
	toolCallId: string,
): string {
	const renderable = tool as RegisteredTool & {
		renderResult(
			result: PtcToolResult,
			options: { expanded: boolean; isPartial: boolean },
			theme: Theme,
			context: PtcRenderContext,
		): { render(width: number): string[] };
	};
	const context: PtcRenderContext = {
		toolCallId,
		cwd: process.cwd(),
		state: {},
		invalidate: () => undefined,
		lastComponent: undefined,
		expanded: false,
		showImages: false,
		isError: false,
	};
	return renderable
		.renderResult(result, { expanded: false, isPartial: false }, TEST_THEME, context)
		.render(120)
		.map((line) => stripTerminalSequences(line).trim())
		.filter(Boolean)
		.join("\n");
}
