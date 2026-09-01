import type { Presentation } from "./config.ts";
import type { ExtensionAPI, ExtensionContext } from "./host.ts";
import type { CapturedPiSession } from "./pi-runtime.ts";
import type { FailureDetailsStore, PtcLifecycle } from "./ptc-tool-contract.ts";

export const INERT_STATUS = "ptc: inert";
export const MISSING_RUNTIME_CAPTURE_MESSAGE =
	"pi-ptc staying inert: ptc runtime capture is missing";
export const RUNTIME_INCOMPATIBILITY_PREFIX = "pi-ptc staying inert";
export const PTC_RUNTIME_UNAVAILABLE_MESSAGE = "ptc runtime capture is unavailable";
export const OBSOLETE_CAPTURE_CONTRACT_MESSAGE =
	"captured Pi runtime does not provide exact argument preparation";
export const OWNED_TRANSPORT_CLEANUP_FAILURE_PREFIX = "owned ptc transport cleanup failed";
export const CATALOG_ROLLBACK_FAILURE_PREFIX = "catalog rollback failed";
export const NATIVE_RESTORATION_RETRY_FAILURE_PREFIX =
	"native active-tool restoration retry failed";
export const NATIVE_RESTORATION_VERIFICATION_FAILURE =
	"native active-tool restoration verification failed";
export const TOOL_CALL_EVENT_ARGUMENT_INDEX = 0;
export const BEFORE_AGENT_START_SYSTEM_PROMPT_ARGUMENT_INDEX = 2;
export const BEFORE_AGENT_START_OPTIONS_ARGUMENT_INDEX = 3;

export type PtcLifecycleOptions = {
	readonly pi: ExtensionAPI;
	readonly initialPresentation: Presentation;
	readonly maxParallelDispatches: number;
	readonly failureDetails: FailureDetailsStore;
	clearRenderSnapshots(): void;
};

export interface PtcLifecycleController extends PtcLifecycle {
	readonly presentation: Presentation;
	setPresentation(presentation: Presentation): void;
	sessionStart(context: ExtensionContext, presentation: Presentation): void;
	apply(context: ExtensionContext): void;
	requireActive(context: ExtensionContext): boolean;
	markRuntimeEventReadiness(context: ExtensionContext): void;
	finalizeToolCall(args: readonly unknown[], result: unknown, context: unknown): unknown;
	finalizeBeforeAgentStart(args: readonly unknown[], result: unknown, context: unknown): unknown;
}

export type CaptureReadiness = "pending" | "active" | "inert";
export type AggregatedToolCallResult = { block?: unknown };
export type AggregatedBeforeAgentStartResult = { messages?: unknown; systemPrompt?: unknown };

export function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

export function isBlockingToolCallResult(value: unknown): value is AggregatedToolCallResult {
	return isRecord(value) && value.block === true;
}

export function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
	return (
		actual.length === expected.length && actual.every((name, index) => name === expected[index])
	);
}

export function supportsCurrentCaptureContract(session: CapturedPiSession): boolean {
	return (
		typeof (session as unknown as { prepareToolArguments?: unknown }).prepareToolArguments ===
		"function"
	);
}
