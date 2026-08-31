import type { ExtensionContext } from "./host.ts";
import type { PiRuntimeCapture } from "./pi-runtime.ts";
import type { ToolCatalogEntry } from "./tool-catalog.ts";
import type { ToolExecutor } from "./tool-executor-contract.ts";
import type { FailureDetailsStore, PtcBindingContext, PtcExecution } from "./transport.ts";

export type PtcLifecycleClearReason =
	| "shutdown"
	| "reload"
	| "incompatibility"
	| "competing-owner"
	| "teardown";

export interface PtcExecutionLease {
	readonly generation: number;
	readonly catalog: readonly ToolCatalogEntry[];
	readonly dispatch: ToolExecutor;
	assertCurrent(): void;
	transitionToInert(error: unknown, context?: ExtensionContext): void;
	release(): void;
}

export interface PtcLifecycle {
	capture(capture: PiRuntimeCapture): void;
	issueExecutionLease(): PtcExecutionLease;
	createExecution(context: PtcBindingContext): PtcExecution;
	consumeFailure(toolCallId: string): ReturnType<FailureDetailsStore["consume"]>;
	clear(reason: PtcLifecycleClearReason): void;
}
