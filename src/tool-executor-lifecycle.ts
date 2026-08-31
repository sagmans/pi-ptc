import { SHIPPED_PTC_CONFIG } from "./config.ts";
import type { CapturedPiSession } from "./pi-runtime.ts";
import type { ToolCatalogEntry } from "./tool-catalog.ts";
import type {
	NestedToolDispatchRequest,
	NestedToolRuntimeResult,
} from "./tool-executor-contract.ts";
import {
	type AfterToolCallResult,
	type BeforeToolCallResult,
	type ExecutedCall,
	isRecord,
	OPERATION_ABORTED_MESSAGE,
	type Preparation,
	type PreparedCall,
	SYNTHETIC_RUNTIME_NAME,
	type SyntheticAgentContext,
	type SyntheticAgentTool,
	type SyntheticAssistantMessage,
	TOOL_EXECUTION_BLOCKED_MESSAGE,
	type ToolCall,
	type UpdateDeliveryOutcome,
	ZERO_USAGE,
} from "./tool-executor-state.ts";

export const TOOL_UPDATE_LIMIT_MESSAGE = "tool update limit exceeded";

export function errorResult(message: string): NestedToolRuntimeResult {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createSyntheticAgentTool(entry: ToolCatalogEntry): SyntheticAgentTool {
	const definition = isRecord(entry.definition) ? entry.definition : undefined;
	return {
		name: entry.name,
		label: typeof definition?.label === "string" ? definition.label : entry.name,
		description: typeof definition?.description === "string" ? definition.description : "",
		parameters: entry.executable.parameters,
		...(entry.executable.prepareArguments
			? { prepareArguments: entry.executable.prepareArguments }
			: {}),
		...(entry.executable.executionMode ? { executionMode: entry.executable.executionMode } : {}),
		execute: entry.executable.execute,
	};
}

export function syntheticCallContext(
	toolCall: ToolCall,
	tools: SyntheticAgentTool[],
): { assistantMessage: SyntheticAssistantMessage; context: SyntheticAgentContext } {
	const assistantMessage: SyntheticAssistantMessage = {
		role: "assistant",
		content: [toolCall],
		api: SYNTHETIC_RUNTIME_NAME,
		provider: SYNTHETIC_RUNTIME_NAME,
		model: SYNTHETIC_RUNTIME_NAME,
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	return {
		assistantMessage,
		context: {
			systemPrompt: "",
			messages: [assistantMessage],
			tools,
		},
	};
}

export async function prepareToolCall(
	session: CapturedPiSession,
	toolsByName: ReadonlyMap<string, ToolCatalogEntry>,
	contextTools: SyntheticAgentTool[],
	toolCall: ToolCall,
	signal?: AbortSignal,
): Promise<Preparation> {
	const entry = toolsByName.get(toolCall.name);
	if (!entry) {
		return {
			kind: "immediate",
			result: errorResult(`Tool ${toolCall.name} not found`),
			isError: true,
			hasExecutionArgs: false,
		};
	}
	let executionArgs: unknown;
	let hasExecutionArgs = false;
	try {
		const preparation = session.prepareToolArguments(
			toolCall.name,
			toolCall.arguments,
			entry.executable,
		);
		if (!preparation.ok) throw new Error(preparation.message);
		executionArgs = preparation.value;
		hasExecutionArgs = true;
		const synthetic = syntheticCallContext(toolCall, contextTools);
		const beforeResult = (await session.beforeToolCall(
			{
				assistantMessage: synthetic.assistantMessage,
				toolCall,
				args: executionArgs,
				context: synthetic.context,
			},
			signal,
		)) as BeforeToolCallResult | undefined;
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: errorResult(OPERATION_ABORTED_MESSAGE),
				isError: true,
				hasExecutionArgs,
				executionArgs,
			};
		}
		if (beforeResult?.block) {
			const reason =
				typeof beforeResult.reason === "string" && beforeResult.reason
					? beforeResult.reason
					: TOOL_EXECUTION_BLOCKED_MESSAGE;
			const result = errorResult(reason);
			if (beforeResult.terminate === true) result.terminate = true;
			return {
				kind: "immediate",
				result,
				isError: true,
				hasExecutionArgs,
				executionArgs,
			};
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: errorResult(OPERATION_ABORTED_MESSAGE),
				isError: true,
				hasExecutionArgs,
				executionArgs,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool: entry.executable,
			args: executionArgs,
			assistantMessage: synthetic.assistantMessage,
			context: synthetic.context,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: errorResult(errorMessage(error)),
			isError: true,
			hasExecutionArgs,
			...(hasExecutionArgs ? { executionArgs } : {}),
		};
	}
}

export async function executePreparedToolCall(
	prepared: PreparedCall,
	session: CapturedPiSession,
	signal: AbortSignal | undefined,
	onUpdate: NestedToolDispatchRequest["onUpdate"],
): Promise<ExecutedCall> {
	const updateEvents: Promise<UpdateDeliveryOutcome>[] = [];
	let acceptingUpdates = true;
	let updateLimitError: Error | undefined;
	let executed: ExecutedCall;
	try {
		const result = (await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args,
			signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				if (updateEvents.length >= SHIPPED_PTC_CONFIG.maxToolUpdatesPerDispatch) {
					updateLimitError = new Error(TOOL_UPDATE_LIMIT_MESSAGE);
					acceptingUpdates = false;
					return;
				}
				const deliveries: Promise<unknown>[] = [];
				try {
					deliveries.push(Promise.resolve(onUpdate?.(partialResult)));
				} catch (error) {
					deliveries.push(Promise.reject(error));
				}
				try {
					deliveries.push(
						Promise.resolve(
							session.extensionRunner.emit({
								type: "tool_execution_update",
								toolCallId: prepared.toolCall.id,
								toolName: prepared.toolCall.name,
								args: prepared.toolCall.arguments,
								partialResult,
							}),
						),
					);
				} catch (error) {
					deliveries.push(Promise.reject(error));
				}
				updateEvents.push(
					Promise.allSettled(deliveries).then((settled) => {
						const failure = settled.find((delivery) => delivery.status === "rejected");
						return failure ? { kind: "failed", error: failure.reason } : { kind: "delivered" };
					}),
				);
			},
		)) as NestedToolRuntimeResult;
		executed = { result, isError: false };
	} catch (error) {
		executed = { result: errorResult(errorMessage(error)), isError: true };
	} finally {
		acceptingUpdates = false;
	}
	const updateOutcomes = await Promise.all(updateEvents);
	const updateFailure = updateOutcomes.find(
		(outcome): outcome is Extract<UpdateDeliveryOutcome, { kind: "failed" }> =>
			outcome.kind === "failed",
	);
	const deliveryError = updateLimitError ?? updateFailure?.error;
	return executed.isError || deliveryError === undefined
		? executed
		: { result: errorResult(errorMessage(deliveryError)), isError: true };
}

export async function finalizeExecutedToolCall(
	prepared: PreparedCall,
	executed: ExecutedCall,
	session: CapturedPiSession,
	signal?: AbortSignal,
): Promise<ExecutedCall> {
	let result = executed.result;
	let isError = executed.isError;
	try {
		const afterResult = (await session.afterToolCall(
			{
				assistantMessage: prepared.assistantMessage,
				toolCall: prepared.toolCall,
				args: prepared.args,
				result,
				isError,
				context: prepared.context,
			},
			signal,
		)) as AfterToolCallResult | undefined;
		if (afterResult) {
			result = {
				...result,
				content: afterResult.content ?? result.content,
				details: afterResult.details ?? result.details,
				usage: afterResult.usage ?? result.usage,
				terminate: afterResult.terminate ?? result.terminate,
			};
			isError = typeof afterResult.isError === "boolean" ? afterResult.isError : isError;
		}
	} catch (error) {
		result = errorResult(errorMessage(error));
		isError = true;
	}
	return { result, isError };
}
