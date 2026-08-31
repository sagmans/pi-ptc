import type { DISPATCH_LOG_TYPE } from "./config.ts";
import type { JsonValue } from "./json.ts";

export type DispatchLogEntry = {
	customType: typeof DISPATCH_LOG_TYPE;
	name: string;
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
	name: string;
	args: JsonValue;
	status: DispatchStatus;
	preview?: string;
	result?: DispatchRenderResult;
};

export type DispatchSummary = Omit<DispatchProgress, "result">;
