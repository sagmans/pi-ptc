import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isExclusiveToolName } from "./config.ts";
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
	errorMessage,
	errorResult,
	executePreparedToolCall,
	finalizeExecutedToolCall,
	prepareToolCall,
} from "./tool-executor-lifecycle.ts";
import type { ExecutedCall, ToolCall } from "./tool-executor-state.ts";

export type {
	CreateToolExecutorOptions,
	NestedToolDispatchRequest,
	NestedToolDispatchResult,
	NestedToolRuntimeResult,
	ToolExecutor,
} from "./tool-executor-contract.ts";

export const NESTED_PTC_TOOL_CALL_ID_PREFIX = "pi-ptc-nested-";

export type NestedPtcToolCallToken = {
	readonly toolCallId: string;
	active: boolean;
};

export const nestedPtcToolCallStorage = new AsyncLocalStorage<NestedPtcToolCallToken>();

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
					let activationFailure: unknown;
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
					const addedToolNames = retainedAddedToolNames(finalized.result);
					if (addedToolNames) {
						try {
							await options.activateTools?.(addedToolNames);
						} catch (error) {
							activationFailure = error;
							finalized = { result: errorResult(errorMessage(error)), isError: true };
						}
					}
					await options.session.extensionRunner.emit({
						type: "tool_execution_end",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						result: finalized.result,
						isError: finalized.isError,
					});
					if (activationFailure !== undefined) {
						options.onActivationFailure?.(activationFailure);
					}
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
