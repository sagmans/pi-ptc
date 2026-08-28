import type { DispatchProgress, DispatchStatus, DispatchSummary } from "./dispatch-contract.ts";
import { DISPLAY_TOOL_NAME_MAX_BYTES, sanitizeBoundedDisplayLabel } from "./display-sanitizer.ts";
import type { JsonValue } from "./json.ts";

const DISPATCH_PREVIEW_MAX_CHARACTERS = 1200;
const DISPATCH_PREVIEW_MAX_LINES = 8;
const DISPATCH_START_MARK = "…";
const DISPATCH_OK_MARK = "ok";
const DISPATCH_ERR_MARK = "err";
const ELLIPSIS = "…";

export function dispatchTarget(name: string, args: JsonValue): string {
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
	const mark = dispatchStatusMark(progress.status);
	const name = sanitizeBoundedDisplayLabel(progress.name, DISPLAY_TOOL_NAME_MAX_BYTES);
	const target = dispatchTarget(progress.name, progress.args);
	return target.length > 0 ? `${name} ${mark} ${target}` : `${name} ${mark}`;
}

function dispatchStatusMark(status: DispatchStatus): string {
	switch (status) {
		case "start":
			return DISPATCH_START_MARK;
		case "ok":
			return DISPATCH_OK_MARK;
		case "err":
			return DISPATCH_ERR_MARK;
		default: {
			const _never: never = status;
			throw new Error(String(_never));
		}
	}
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

export function dispatchPreview(name: string, text: string, isError: boolean): string | undefined {
	if (!isError && (name === "read" || name === "edit" || name === "write")) {
		return undefined;
	}
	return boundPreview(text, name === "bash" ? "tail" : "head");
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
