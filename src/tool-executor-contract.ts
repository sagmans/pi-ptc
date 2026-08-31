import type { CapturedPiSession } from "./pi-runtime.ts";
import type { ToolCatalogEntry } from "./tool-catalog.ts";

export type NestedToolRuntimeResult = Record<string, unknown> & {
	content?: unknown;
	details?: unknown;
	usage?: unknown;
	terminate?: unknown;
	addedToolNames?: readonly string[];
};

export type NestedToolDispatchRequest = {
	readonly name: string;
	readonly args: unknown;
	readonly signal?: AbortSignal;
	readonly onUpdate?: (partialResult: unknown) => Promise<void> | void;
};

export type NestedToolDispatchResult = {
	readonly toolCallId: string;
	readonly name: string;
	readonly rawArgs: unknown;
	readonly result: NestedToolRuntimeResult;
	readonly isError: boolean;
	readonly executionArgs?: unknown;
};

export type ToolExecutor = {
	dispatch(request: NestedToolDispatchRequest): Promise<NestedToolDispatchResult>;
};

export type CreateToolExecutorOptions = {
	readonly catalog: readonly ToolCatalogEntry[];
	readonly session: CapturedPiSession;
	readonly activateTools?: (names: readonly string[]) => Promise<void> | void;
};
