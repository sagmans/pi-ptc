// Semantic output measurement. JSON punctuation and escaping must never
// create or erase logical content lines, so line counts walk raw string
// values instead of serialized text.

import type { JsonValue } from "./json.ts";
import type { CodeRunResult } from "./runtime-contract.ts";

const UTF8_ENCODING = "utf8";
const LINE_BREAK_PATTERN = /\r\n|\r|\n/g;

export function logicalTextLineCount(text: string): number {
	return text.split(/\r\n|\r|\n/).length;
}

function embeddedBreakCount(text: string): number {
	return text.match(LINE_BREAK_PATTERN)?.length ?? 0;
}

function extraBreakLines(value: JsonValue): number {
	if (typeof value === "string") return embeddedBreakCount(value);
	if (Array.isArray(value)) {
		return value.reduce<number>((total, item) => total + extraBreakLines(item), 0);
	}
	if (value !== null && typeof value === "object") {
		return Object.values(value).reduce<number>((total, item) => total + extraBreakLines(item), 0);
	}
	return 0;
}

export function logicalJsonLineCount(value: JsonValue): number {
	// A result contributes one logical line plus every CRLF, CR, or LF
	// sequence contained in any string leaf.
	return 1 + extraBreakLines(value);
}

export function outerLogicalLineCount(outcome: Pick<CodeRunResult, "logs" | "result">): number {
	let lines = outcome.logs.reduce((total, log) => total + logicalTextLineCount(log), 0);
	const result = outcome.result;
	if (result !== undefined) lines += logicalJsonLineCount(result);
	return lines;
}

export type OutputMeasurement = { readonly bytes: number; readonly lines: number };

export function measureSerializedJson(
	value: JsonValue,
): OutputMeasurement & { readonly text: string } {
	const text = JSON.stringify(value);
	return {
		text,
		bytes: Buffer.byteLength(text, UTF8_ENCODING),
		lines: logicalJsonLineCount(value),
	};
}
