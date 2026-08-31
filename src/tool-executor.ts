import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isExclusiveToolName } from "./config.ts";
import type { PiRuntimeTool } from "./pi-runtime.ts";
import type { DispatchKind } from "./scheduler.ts";
import type { ToolCatalogEntry } from "./tool-catalog.ts";
import type {
	CreateToolExecutorOptions,
	NestedToolDispatchRequest,
	NestedToolDispatchResult,
	NestedToolRuntimeResult,
	ToolExecutor,
} from "./tool-executor-contract.ts";
import {
	createSyntheticAgentTool,
	executePreparedToolCall,
	finalizeExecutedToolCall,
	prepareToolCall,
} from "./tool-executor-lifecycle.ts";

export type {
	CreateToolExecutorOptions,
	NestedToolDispatchRequest,
	NestedToolDispatchResult,
	NestedToolRuntimeResult,
	ToolExecutor,
} from "./tool-executor-contract.ts";

export const NESTED_PTC_TOOL_CALL_ID_PREFIX = "pi-ptc-nested-";

export const OPERATION_ABORTED_MESSAGE = "Operation aborted";

export const TOOL_EXECUTION_BLOCKED_MESSAGE = "Tool execution was blocked";

export const SYNTHETIC_RUNTIME_NAME = "pi-ptc";

export type NestedPtcToolCallToken = {
	readonly toolCallId: string;
	active: boolean;
};

export const nestedPtcToolCallStorage = new AsyncLocalStorage<NestedPtcToolCallToken>();

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

export function retainedAddedToolNames(
	result: NestedToolRuntimeResult,
): readonly string[] | undefined {
	return Array.isArray(result.addedToolNames) && result.addedToolNames.length > 0
		? result.addedToolNames
		: undefined;
}

export function isNestedPtcToolCall(toolCallId?: string): boolean {
	const token = nestedPtcToolCallStorage.getStore();
	return token?.active === true && (toolCallId === undefined || token.toolCallId === toolCallId);
}

export function classifyToolDispatch(entry: ToolCatalogEntry): DispatchKind {
	if (entry.executable.executionMode === "sequential") return "exclusive";
	if (entry.executable.executionMode === "parallel") return "parallel";
	return isExclusiveToolName(entry.name) ? "exclusive" : "parallel";
}

export function createToolExecutor(options: CreateToolExecutorOptions): ToolExecutor {
	const catalog = [...options.catalog];
	const toolsByName = new Map(catalog.map((entry) => [entry.name, entry]));
	const contextTools = catalog.map(createSyntheticAgentTool);

	return Object.freeze({
		dispatch(request: NestedToolDispatchRequest): Promise<NestedToolDispatchResult> {
			const toolCall: ToolCall = {
				type: "toolCall",
				id: `${NESTED_PTC_TOOL_CALL_ID_PREFIX}${randomUUID()}`,
				name: request.name,
				arguments: request.args,
			};
			const token: NestedPtcToolCallToken = { toolCallId: toolCall.id, active: true };
			return nestedPtcToolCallStorage.run(token, async () => {
				try {
					await options.session.extensionRunner.emit({
						type: "tool_execution_start",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						args: toolCall.arguments,
					});
					const preparation = await prepareToolCall(
						options.session,
						toolsByName,
						contextTools,
						toolCall,
						request.signal,
					);
					let finalized: ExecutedCall;
					let executionArgs: unknown;
					let hasExecutionArgs = false;
					if (preparation.kind === "immediate") {
						finalized = preparation;
						hasExecutionArgs = preparation.hasExecutionArgs;
						executionArgs = preparation.executionArgs;
					} else {
						hasExecutionArgs = true;
						executionArgs = preparation.args;
						const executed = await executePreparedToolCall(
							preparation,
							options.session,
							request.signal,
							request.onUpdate,
						);
						finalized = await finalizeExecutedToolCall(
							preparation,
							executed,
							options.session,
							request.signal,
						);
					}
					await options.session.extensionRunner.emit({
						type: "tool_execution_end",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						result: finalized.result,
						isError: finalized.isError,
					});
					const addedToolNames = retainedAddedToolNames(finalized.result);
					if (addedToolNames) await options.activateTools?.(addedToolNames);
					return {
						toolCallId: toolCall.id,
						name: toolCall.name,
						rawArgs: toolCall.arguments,
						result: finalized.result,
						isError: finalized.isError,
						...(hasExecutionArgs ? { executionArgs } : {}),
					};
				} finally {
					token.active = false;
				}
			});
		},
	});
}
