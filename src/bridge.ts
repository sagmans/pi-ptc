// Host side of tools.*: factory execute stays off the model transcript.

import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";

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
import { type JsonValue, snapshotJsonValue } from "./json.ts";
import type { BindingFn } from "./runtime.ts";
import type { Scheduler } from "./scheduler.ts";

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

const DISPATCH_PREVIEW_MAX_CHARACTERS = 1200;
const DISPATCH_PREVIEW_MAX_LINES = 8;
const DISPATCH_START_MARK = "…";
const DISPATCH_OK_MARK = "ok";
const DISPATCH_ERR_MARK = "err";
const ELLIPSIS = "…";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function dispatchTarget(name: CoreToolName, args: JsonValue): string {
	if (!isRecord(args)) return "";
	if (name === "bash") {
		return typeof args.command === "string" ? args.command : "";
	}
	if (name === "grep" || name === "find") {
		if (typeof args.path === "string") return args.path;
		return typeof args.pattern === "string" ? args.pattern : "";
	}
	return typeof args.path === "string" ? args.path : "";
}

export function formatDispatchLine(
	progress: Pick<DispatchProgress, "name" | "args" | "status">,
): string {
	let mark: string;
	switch (progress.status) {
		case "start":
			mark = DISPATCH_START_MARK;
			break;
		case "ok":
			mark = DISPATCH_OK_MARK;
			break;
		case "err":
			mark = DISPATCH_ERR_MARK;
			break;
		default: {
			const _never: never = progress.status;
			throw new Error(`unhandled dispatch status: ${_never}`);
		}
	}
	const target = dispatchTarget(progress.name, progress.args);
	return target.length > 0 ? `${progress.name} ${mark} ${target}` : `${progress.name} ${mark}`;
}

function trimEmptyEdgeLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start]?.length === 0) start += 1;
	while (end > start && lines[end - 1]?.length === 0) end -= 1;
	return lines.slice(start, end);
}

function boundPreview(text: string, direction: "head" | "tail"): string | undefined {
	const lines = trimEmptyEdgeLines(text.replaceAll("\r\n", "\n").split("\n"));
	if (lines.length === 0) return undefined;
	const clippedLines =
		direction === "head"
			? lines.slice(0, DISPATCH_PREVIEW_MAX_LINES)
			: lines.slice(-DISPATCH_PREVIEW_MAX_LINES);
	if (lines.length > DISPATCH_PREVIEW_MAX_LINES) {
		if (direction === "head") clippedLines.push(ELLIPSIS);
		else clippedLines.unshift(ELLIPSIS);
	}
	const preview = clippedLines.join("\n");
	if (preview.length <= DISPATCH_PREVIEW_MAX_CHARACTERS) return preview;
	const contentLength = DISPATCH_PREVIEW_MAX_CHARACTERS - ELLIPSIS.length;
	return direction === "head"
		? preview.slice(0, contentLength) + ELLIPSIS
		: ELLIPSIS + preview.slice(-contentLength);
}

function dispatchPreview(name: CoreToolName, text: string, isError: boolean): string | undefined {
	if (!isError && (name === "read" || name === "edit" || name === "write")) {
		return undefined;
	}
	return boundPreview(text, name === "bash" ? "tail" : "head");
}

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

const CALL_ID_PREFIX = "ptc";

export function createFactoryExecutor(
	tools: FactoryToolSet,
	signal?: AbortSignal,
): FactoryExecutor {
	let nextId = 1;
	return async (name, args, dispatchSignal, onUpdate) => {
		const id = nextId;
		nextId += 1;
		return await tools[name].execute(
			`${CALL_ID_PREFIX}:${name}:${id}`,
			args,
			dispatchSignal ?? signal,
			onUpdate,
		);
	};
}

export function createOfficialExecutor(cwd: string, signal?: AbortSignal): FactoryExecutor {
	const tools = {
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		find: createFindTool(cwd),
		grep: createGrepTool(cwd),
		ls: createLsTool(cwd),
		read: createReadTool(cwd),
		write: createWriteTool(cwd),
	} as unknown as FactoryToolSet;
	return createFactoryExecutor(tools, signal);
}

export function createCoreBindings(input: {
	execute: FactoryExecutor;
	scheduler: Scheduler;
	signal?: AbortSignal;
	appendLog?: (entry: DispatchLogEntry) => void;
	emit?: (name: string, payload: unknown) => void;
	reportDispatch?: (progress: DispatchProgress) => void;
}): CoreBindings {
	const bindings = Object.create(null) as CoreBindings;
	let nextDispatchId = 1;
	for (const name of CORE_TOOL_NAMES) {
		bindings[name] = async (rawArgs, invocationSignal) => {
			const id = nextDispatchId;
			nextDispatchId += 1;
			const args = snapshotJsonValue(rawArgs);
			const kind = isExclusiveToolName(name) ? "exclusive" : "parallel";
			const signal = invocationSignal ?? input.signal;
			return await input.scheduler.run(
				kind,
				async () => {
					let isError = false;
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
						input.appendLog?.({ customType: DISPATCH_LOG_TYPE, name, args, isError });
						input.emit?.(DISPATCH_EVENT, { name, args, isError });
						const preview = dispatchPreview(name, textFromContent(result.content), false);
						const progress: DispatchProgress = {
							id,
							name,
							args,
							status: "ok",
							result: settledResult,
						};
						if (preview !== undefined) progress.preview = preview;
						input.reportDispatch?.(progress);
						return value;
					} catch (error) {
						isError = true;
						input.appendLog?.({ customType: DISPATCH_LOG_TYPE, name, args, isError });
						input.emit?.(DISPATCH_EVENT, { name, args, isError });
						const message = error instanceof Error ? error.message : String(error);
						const preview = dispatchPreview(name, message, true);
						const progress: DispatchProgress = {
							id,
							name,
							args,
							status: "err",
							result:
								settledResult?.isError === true
									? settledResult
									: {
											content: [{ type: "text", text: message }],
											isError: true,
										},
						};
						if (preview !== undefined) progress.preview = preview;
						input.reportDispatch?.(progress);
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

export function summarizeDispatchProgress(progress: DispatchProgress): DispatchSummary {
	const summary: DispatchSummary = {
		id: progress.id,
		name: progress.name,
		args: progress.args,
		status: progress.status,
	};
	if (progress.preview !== undefined) summary.preview = progress.preview;
	return summary;
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
