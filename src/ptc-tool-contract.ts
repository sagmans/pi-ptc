import type { DispatchProgress } from "./dispatch-contract.ts";
import type { PtcDispatchDetails } from "./dispatch-details.ts";
import type { ExtensionContext } from "./host.ts";
import type { PiRuntimeCapture } from "./pi-runtime.ts";
import type { PtcDefinitionRegistry } from "./renderer-contract.ts";
import type { BindingFn } from "./runtime-contract.ts";
import type { ToolCatalogEntry } from "./tool-catalog.ts";
import type { ToolExecutor } from "./tool-executor-contract.ts";

export type PtcLifecycleClearReason =
	| "shutdown"
	| "reload"
	| "incompatibility"
	| "competing-owner"
	| "teardown";

export type PtcParams = {
	code: string;
	description: string;
};

export type PtcExecuteContext = {
	cwd: string;
	signal?: AbortSignal;
};

export type PtcBindingContext = PtcExecuteContext & {
	reportDispatch?: (progress: DispatchProgress) => void;
	isOpen(): boolean;
};

export type PtcPartialResult = {
	content: Array<{ type: "text"; text: string }>;
	details: PtcDispatchDetails;
};

export type PtcOnUpdate = (partial: PtcPartialResult) => void;

export type PtcToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: PtcDispatchDetails;
};

export type FailureDetailsStore = {
	remember(toolCallId: string, details: PtcDispatchDetails): void;
	consume(toolCallId: string): PtcDispatchDetails | undefined;
	clear(): void;
};

export type PtcExecution = {
	bindings: Record<string, BindingFn>;
	definitions?: PtcDefinitionRegistry;
	release?(): void;
};

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
