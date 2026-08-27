import {
	type FactoryResult,
	ToolCallError,
	textFromContent,
	toCanonicalValue,
} from "./canonical.ts";
import {
	CORE_TOOL_NAMES,
	type CoreToolName,
	DISPATCH_EVENT,
	DISPATCH_LOG_TYPE,
	isExclusiveToolName,
} from "./config.ts";
import type {
	CoreBindings,
	DispatchLogEntry,
	DispatchProgress,
	DispatchRenderResult,
	FactoryExecutor,
} from "./dispatch-contract.ts";
import { projectDisplayArguments } from "./dispatch-details.ts";
import { dispatchPreview } from "./dispatch-format.ts";
import { type JsonValue, snapshotJsonValue } from "./json.ts";
import type { Scheduler } from "./scheduler.ts";

const ELLIPSIS = "…";

type CoreBindingsInput = {
	execute: FactoryExecutor;
	scheduler: Scheduler;
	appendLog?: (entry: DispatchLogEntry) => void;
	emit?: (name: string, payload: unknown) => void;
	acceptSideEffects?: () => boolean;
	reportDispatch?: (progress: DispatchProgress) => void;
};

export function createCoreBindings(input: CoreBindingsInput): CoreBindings {
	const bindings = Object.create(null) as CoreBindings;
	let nextDispatchId = 1;
	for (const name of CORE_TOOL_NAMES) {
		bindings[name] = async (rawArgs, signal) => {
			const id = nextDispatchId;
			nextDispatchId += 1;
			const args = snapshotJsonValue(rawArgs);
			const kind = isExclusiveToolName(name) ? "exclusive" : "parallel";
			return await input.scheduler.run(
				kind,
				async () => {
					let settledResult: DispatchRenderResult | undefined;
					input.reportDispatch?.({ id, name, args, status: "start" });
					try {
						const result = await input.execute(name, args, signal, (partial) => {
							input.reportDispatch?.({
								id,
								name,
								args,
								status: "start",
								result: toDispatchRenderResult(partial, false),
							});
						});
						settledResult = toDispatchRenderResult(result, result.isError === true);
						const value = toCanonicalValue(name, result);
						reportSideEffects(input, name, args, false);
						input.reportDispatch?.(createSuccessProgress(id, name, args, result, settledResult));
						return value;
					} catch (error) {
						reportSideEffects(input, name, args, true);
						const message = error instanceof Error ? error.message : String(error);
						input.reportDispatch?.(createErrorProgress(id, name, args, message, settledResult));
						if (error instanceof ToolCallError) throw error;
						throw new ToolCallError(name, message);
					}
				},
				signal,
			);
		};
	}
	return bindings;
}

function reportSideEffects(
	input: CoreBindingsInput,
	name: CoreToolName,
	args: JsonValue,
	isError: boolean,
): void {
	const displayArgs = projectDisplayArguments(name, args);
	if (input.acceptSideEffects?.() === false) return;
	input.appendLog?.({
		customType: DISPATCH_LOG_TYPE,
		name,
		args: displayArgs,
		isError,
	});
	input.emit?.(DISPATCH_EVENT, { name, args: displayArgs, isError });
}

function createSuccessProgress(
	id: number,
	name: CoreToolName,
	args: JsonValue,
	result: FactoryResult,
	renderResult: DispatchRenderResult,
): DispatchProgress {
	const preview = dispatchPreview(name, textFromContent(result.content), false);
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
	name: CoreToolName,
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

function toDispatchRenderResult(result: FactoryResult, isError: boolean): DispatchRenderResult {
	return {
		content: result.content.map((block) => {
			const content: DispatchRenderResult["content"][number] = { type: block.type };
			if (block.text !== undefined) content.text = block.text;
			if (block.data !== undefined) content.data = block.data;
			if (block.mimeType !== undefined) content.mimeType = block.mimeType;
			return content;
		}),
		details: result.details,
		isError,
	};
}
