import type { FactoryResult } from "./canonical.ts";
import type { CoreToolName, DISPATCH_LOG_TYPE } from "./config.ts";
import type { JsonValue } from "./json.ts";
import type { BindingFn } from "./runtime-contract.ts";

export type DispatchLogEntry = {
	customType: typeof DISPATCH_LOG_TYPE;
	name: CoreToolName;
	args: JsonValue;
	isError: boolean;
};

export type DispatchStatus = "start" | "ok" | "err";

export type DispatchRenderResult = {
	content: Array<{
		type: string;
		text?: string;
		data?: string;
		mimeType?: string;
	}>;
	details?: unknown;
	isError: boolean;
};

export type DispatchProgress = {
	id: number;
	name: CoreToolName;
	args: JsonValue;
	status: DispatchStatus;
	preview?: string;
	result?: DispatchRenderResult;
};

export type DispatchSummary = Omit<DispatchProgress, "result">;

export type FactoryUpdate = (result: FactoryResult) => void;

export type FactoryExecutor = (
	name: CoreToolName,
	args: JsonValue,
	signal?: AbortSignal,
	onUpdate?: FactoryUpdate,
) => Promise<FactoryResult>;

export type FactoryTool = {
	execute(
		toolCallId: string,
		params: JsonValue,
		signal?: AbortSignal,
		onUpdate?: FactoryUpdate,
	): Promise<FactoryResult>;
};

export type FactoryToolSet = Record<CoreToolName, FactoryTool>;
export type CoreBindings = Record<CoreToolName, BindingFn>;
