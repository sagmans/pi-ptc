import {
	projectCanonicalContent,
	ToolCallError,
	ToolResultDeliveryError,
	textFromContent,
	toToolCanonicalValue,
} from "./canonical.ts";
import { DISPATCH_EVENT, DISPATCH_LOG_TYPE, isCoreToolName } from "./config.ts";
import type {
	DispatchLogEntry,
	DispatchProgress,
	DispatchRenderResult,
} from "./dispatch-contract.ts";
import { projectDisplayArguments } from "./dispatch-details.ts";
import { dispatchPreview } from "./dispatch-format.ts";
import {
	attachLiveDispatchArguments,
	attachLiveDispatchResult,
	attachLiveDispatchRetentionResult,
} from "./dispatch-live.ts";
import { type JsonValue, snapshotJsonValue } from "./json.ts";
import type { BindingFn } from "./runtime-contract.ts";
import type { Scheduler } from "./scheduler.ts";
import type { ToolCatalogEntry } from "./tool-catalog.ts";
import {
	classifyToolDispatch,
	type NestedToolRuntimeResult,
	type ToolExecutor,
} from "./tool-executor.ts";

const ELLIPSIS = "…";

export type ToolBindingReporting = {
	appendLog?: (entry: DispatchLogEntry) => void;
	emit?: (name: string, payload: unknown) => void;
	acceptSideEffects?: () => boolean;
	reportDispatch?: (progress: DispatchProgress) => void;
};

export function createToolBindings(
	snapshot: readonly ToolCatalogEntry[],
	executor: ToolExecutor,
	scheduler: Scheduler,
	reporting: ToolBindingReporting,
): Record<string, BindingFn> {
	const entries = [...snapshot];
	const bindings = Object.create(null) as Record<string, BindingFn>;
	let nextDispatchId = 1;
	for (const entry of entries) {
		bindings[entry.name] = async (rawArgs, signal) => {
			const id = nextDispatchId;
			nextDispatchId += 1;
			const args = snapshotJsonValue(rawArgs);
			const core = isCoreToolName(entry.name);
			const progressArgs = projectDisplayArguments(entry.name, args);
			return await scheduler.run(
				classifyToolDispatch(entry),
				async () => {
					let settledResult: DispatchRenderResult | undefined;
					let rawSettledResult: unknown;
					let hasRawSettledResult = false;
					reportProgress(
						reporting,
						{ id, name: entry.name, args: progressArgs, status: "start" },
						args,
					);
					try {
						const outcome = await executor.dispatch({
							name: entry.name,
							args,
							signal,
							onUpdate(partialResult) {
								const renderResult = toDispatchRenderResult(partialResult, false);
								const progress: DispatchProgress = {
									id,
									name: entry.name,
									args: progressArgs,
									status: "start",
									...(core ? { result: renderResult } : {}),
								};
								reportProgress(reporting, progress, args, {
									result: partialResult,
									retentionResult: renderResult,
								});
							},
						});
						rawSettledResult = outcome.result;
						hasRawSettledResult = true;
						settledResult = toDispatchRenderResult(outcome.result, outcome.isError);
						let value: JsonValue;
						try {
							value = toToolCanonicalValue(entry.name, outcome.result, outcome.isError);
						} catch (error) {
							if (outcome.isError || error instanceof ToolCallError) throw error;
							throw new ToolResultDeliveryError(
								entry.name,
								error instanceof Error ? error.message : String(error),
							);
						}
						reportSideEffects(reporting, entry.name, args, false);
						const progress = createSuccessProgress(
							id,
							entry.name,
							progressArgs,
							outcome.result,
							core ? settledResult : undefined,
						);
						reportProgress(reporting, progress, args, {
							result: outcome.result,
							retentionResult: settledResult,
						});
						return value;
					} catch (error) {
						reportSideEffects(reporting, entry.name, args, true);
						const message = error instanceof Error ? error.message : String(error);
						const renderResult = createErrorRenderResult(entry.name, message, settledResult);
						const progress = createErrorProgress(
							id,
							entry.name,
							progressArgs,
							message,
							core ? renderResult : undefined,
						);
						if (hasRawSettledResult) {
							attachLiveDispatchResult(progress, rawSettledResult, renderResult);
						} else {
							attachLiveDispatchRetentionResult(progress, renderResult);
						}
						reportProgress(reporting, progress, args);
						if (error instanceof ToolCallError || error instanceof ToolResultDeliveryError)
							throw error;
						throw new ToolCallError(entry.name, message);
					}
				},
				signal,
			);
		};
	}
	return bindings;
}

function reportProgress(
	reporting: ToolBindingReporting,
	progress: DispatchProgress,
	args: JsonValue,
	result?: { result: unknown; retentionResult: DispatchRenderResult },
): void {
	attachLiveDispatchArguments(progress, args);
	if (result) attachLiveDispatchResult(progress, result.result, result.retentionResult);
	reporting.reportDispatch?.(progress);
}

function reportSideEffects(
	reporting: ToolBindingReporting,
	name: string,
	args: JsonValue,
	isError: boolean,
): void {
	const displayArgs = projectDisplayArguments(name, args);
	if (reporting.acceptSideEffects?.() === false) return;
	reporting.appendLog?.({
		customType: DISPATCH_LOG_TYPE,
		name,
		args: displayArgs,
		isError,
	});
	reporting.emit?.(DISPATCH_EVENT, { name, args: displayArgs, isError });
}

function createSuccessProgress(
	id: number,
	name: string,
	args: JsonValue,
	result: NestedToolRuntimeResult,
	renderResult: DispatchRenderResult | undefined,
): DispatchProgress {
	const content = readResultContent(result);
	const preview = dispatchPreview(name, textFromContent(projectCanonicalContent(content)), false);
	const progress: DispatchProgress = {
		id,
		name,
		args,
		status: "ok",
		...(renderResult ? { result: renderResult } : {}),
	};
	if (preview !== undefined) progress.preview = preview;
	return progress;
}

function createErrorProgress(
	id: number,
	name: string,
	args: JsonValue,
	message: string,
	renderResult: DispatchRenderResult | undefined,
): DispatchProgress {
	const preview = dispatchPreview(name, message, true);
	const progress: DispatchProgress = {
		id,
		name,
		args,
		status: "err",
		...(renderResult ? { result: renderResult } : {}),
	};
	if (preview !== undefined) progress.preview = preview;
	return progress;
}

function createErrorRenderResult(
	name: string,
	message: string,
	settledResult: DispatchRenderResult | undefined,
): DispatchRenderResult {
	if (settledResult?.isError === true) return settledResult;
	const preview = dispatchPreview(name, message, true);
	return {
		content: [{ type: "text", text: preview ?? ELLIPSIS }],
		isError: true,
	};
}

function readResultContent(result: NestedToolRuntimeResult): unknown {
	try {
		return Reflect.get(result, "content");
	} catch {
		return undefined;
	}
}

function readResultDetails(result: NestedToolRuntimeResult): unknown {
	try {
		return Reflect.get(result, "details");
	} catch {
		return undefined;
	}
}

function toDispatchRenderResult(result: unknown, isError: boolean): DispatchRenderResult {
	const record = isUnknownRecord(result) ? result : {};
	return {
		content: projectCanonicalContent(readResultContent(record)),
		details: readResultDetails(record),
		isError,
	};
}

function isUnknownRecord(value: unknown): value is NestedToolRuntimeResult {
	if (typeof value !== "object" || value === null) return false;
	try {
		return !Array.isArray(value);
	} catch {
		return false;
	}
}
