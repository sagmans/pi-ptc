import {
	projectCanonicalContent,
	ToolCallError,
	textFromContent,
	toToolCanonicalValue,
} from "./canonical.ts";
import { DISPATCH_EVENT, DISPATCH_LOG_TYPE } from "./config.ts";
import type {
	DispatchLogEntry,
	DispatchProgress,
	DispatchRenderResult,
} from "./dispatch-contract.ts";
import { projectDisplayArguments } from "./dispatch-details.ts";
import { dispatchPreview } from "./dispatch-format.ts";
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
			return await scheduler.run(
				classifyToolDispatch(entry),
				async () => {
					let settledResult: DispatchRenderResult | undefined;
					reporting.reportDispatch?.({ id, name: entry.name, args, status: "start" });
					try {
						const outcome = await executor.dispatch({
							name: entry.name,
							args,
							signal,
							onUpdate(partialResult) {
								reporting.reportDispatch?.({
									id,
									name: entry.name,
									args,
									status: "start",
									result: toDispatchRenderResult(partialResult, false),
								});
							},
						});
						settledResult = toDispatchRenderResult(outcome.result, outcome.isError);
						const value = toToolCanonicalValue(entry.name, outcome.result, outcome.isError);
						reportSideEffects(reporting, entry.name, args, false);
						reporting.reportDispatch?.(
							createSuccessProgress(id, entry.name, args, outcome.result, settledResult),
						);
						return value;
					} catch (error) {
						reportSideEffects(reporting, entry.name, args, true);
						const message = error instanceof Error ? error.message : String(error);
						reporting.reportDispatch?.(
							createErrorProgress(id, entry.name, args, message, settledResult),
						);
						if (error instanceof ToolCallError) throw error;
						throw new ToolCallError(entry.name, message);
					}
				},
				signal,
			);
		};
	}
	return bindings;
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
	renderResult: DispatchRenderResult,
): DispatchProgress {
	const content = readResultContent(result);
	const preview = dispatchPreview(name, textFromContent(projectCanonicalContent(content)), false);
	const progress: DispatchProgress = {
		id,
		name,
		args,
		status: "ok",
		result: renderResult,
	};
	if (preview !== undefined) progress.preview = preview;
	return progress;
}

function createErrorProgress(
	id: number,
	name: string,
	args: JsonValue,
	message: string,
	settledResult: DispatchRenderResult | undefined,
): DispatchProgress {
	const preview = dispatchPreview(name, message, true);
	const displayMessage = preview ?? ELLIPSIS;
	const progress: DispatchProgress = {
		id,
		name,
		args,
		status: "err",
		result:
			settledResult?.isError === true
				? settledResult
				: {
						content: [{ type: "text", text: displayMessage }],
						isError: true,
					},
	};
	if (preview !== undefined) progress.preview = preview;
	return progress;
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
