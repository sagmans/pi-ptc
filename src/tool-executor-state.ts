import type { PiRuntimeTool } from "./pi-runtime.ts";
import type { NestedToolRuntimeResult } from "./tool-executor-contract.ts";

export const OPERATION_ABORTED_MESSAGE = "Operation aborted";
export const TOOL_EXECUTION_BLOCKED_MESSAGE = "Tool execution was blocked";
export const SYNTHETIC_RUNTIME_NAME = "pi-ptc";

export const ZERO_USAGE = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

export type ToolCall = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: unknown;
};

export type SyntheticAssistantMessage = {
	role: "assistant";
	content: [ToolCall];
	api: string;
	provider: string;
	model: string;
	usage: typeof ZERO_USAGE;
	stopReason: "toolUse";
	timestamp: number;
};

export type SyntheticAgentTool = PiRuntimeTool & {
	name: string;
	label: string;
	description: string;
};

export type SyntheticAgentContext = {
	systemPrompt: string;
	messages: [SyntheticAssistantMessage];
	tools: SyntheticAgentTool[];
};

export type BeforeToolCallResult = {
	block?: unknown;
	reason?: unknown;
	terminate?: unknown;
};

export type AfterToolCallResult = {
	content?: unknown;
	details?: unknown;
	usage?: unknown;
	terminate?: unknown;
	isError?: unknown;
};

export type ImmediatePreparation = {
	kind: "immediate";
	result: NestedToolRuntimeResult;
	isError: true;
	hasExecutionArgs: boolean;
	executionArgs?: unknown;
};

export type PreparedCall = {
	kind: "prepared";
	toolCall: ToolCall;
	tool: PiRuntimeTool;
	args: unknown;
	assistantMessage: SyntheticAssistantMessage;
	context: SyntheticAgentContext;
};

export type Preparation = ImmediatePreparation | PreparedCall;

export type ExecutedCall = {
	result: NestedToolRuntimeResult;
	isError: boolean;
};

export type UpdateDeliveryOutcome = { kind: "delivered" } | { kind: "failed"; error: unknown };

export function isRecord(value: unknown): value is Record<string, unknown> {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}
