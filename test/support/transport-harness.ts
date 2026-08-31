import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";

import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { SHIPPED_PTC_CONFIG } from "../../src/config.ts";
import type { DispatchProgress, DispatchRenderResult } from "../../src/dispatch-contract.ts";
import type { PtcRenderContext } from "../../src/renderer.ts";
import type { createPtcTool } from "../../src/transport.ts";

export const CUSTOM_DRAIN_TIMEOUT_MS = 321;
export const CUSTOM_MAX_DISPATCHES = 37;
export const CUSTOM_MAX_ORPHANED_BINDINGS = 4;
export const CUSTOM_MAX_OUTPUT_BYTES = 1234;
export const CUSTOM_MAX_OUTPUT_LINES = 56;
export const CUSTOM_MAX_PERSISTED_DETAILS_BYTES = 2345;
export const SCALING_DISPATCH_COUNT = 100;
export const SCALING_DESCRIPTION = "inspect dispatch scaling";
export const SCALING_ACCESS_BOUND_PER_DISPATCH = 20;
export const RETENTION_RENDER_BUDGET_BYTES = 64;
export const OVERSIZED_RETAINED_TEXT = "r".repeat(RETENTION_RENDER_BUDGET_BYTES + 1);
export const FIRST_RETAINED_RESULT_TEXT = "first retained result";
export const SECOND_RETAINED_RESULT_TEXT = "second retained resul";
export const FIRST_RETAINED_RESULT = {
	content: [{ type: "text", text: FIRST_RETAINED_RESULT_TEXT }],
	isError: false,
} satisfies DispatchRenderResult;
export const SECOND_RETAINED_RESULT = {
	content: [{ type: "text", text: SECOND_RETAINED_RESULT_TEXT }],
	isError: false,
} satisfies DispatchRenderResult;
export const SINGLE_RETAINED_RESULT_BUDGET_BYTES = Buffer.byteLength(
	JSON.stringify(FIRST_RETAINED_RESULT),
	"utf8",
);
export const HOSTILE_RENDER_DETAILS_MESSAGE = "hostile render details";
export const TIMER_TEST_INTERVAL_MS = 5;
export const TIMER_IDLE_OBSERVATION_MS = 30;
export const OVERSIZED_FAILURE_MESSAGE = "failure".repeat(1000);
export const RAW_CUSTOM_SECRET = "RAW_CUSTOM_SECRET";
export const RAW_CUSTOM_DETAILS_MARKER = "RAW_CUSTOM_DETAILS_MARKER";
export const CUSTOM_CALL_MARKER = "custom call";
export const CUSTOM_RESULT_MARKER = "custom finalized result";

export type PtcExecuteReport = (progress: DispatchProgress) => void;

export const TIMER_THEME = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

export const LIMITS = {
	timeoutMs: 2000,
	maxDispatches: SHIPPED_PTC_CONFIG.maxDispatches,
	maxOutputBytes: 51200,
	maxOutputLines: 2000,
};

initTheme(undefined, false);

export function createRenderContext(toolCallId: string): PtcRenderContext {
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

export async function waitForUpdates(
	updates: unknown[],
	count: number,
	timeoutMs = 1000,
): Promise<void> {
	const started = Date.now();
	while (updates.length < count) {
		if (Date.now() - started > timeoutMs) {
			throw new Error(`timed out waiting for ${count} updates, got ${updates.length}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

export function renderNestedResult(
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
