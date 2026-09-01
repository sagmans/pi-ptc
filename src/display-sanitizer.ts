import type { JsonValue } from "./json.ts";

export const COMPATIBILITY_ERROR_MAX_CHARACTERS = 256;
export const DISPLAY_DESCRIPTION_MAX_BYTES = 4096;
export const DISPLAY_EXECUTION_ERROR_MAX_BYTES = 8192;
export const DISPLAY_PREVIEW_MAX_BYTES = 4096;
export const DISPLAY_TOOL_NAME_MAX_BYTES = 256;

const DISPLAY_TRUNCATION_MARK = "…";
const DISPLAY_LABEL_LAYOUT_CONTROL_PATTERN = /[\t\n]/g;
const ESCAPE_CODE = 0x1b;
const DELETE_CODE = 0x7f;
const C0_CONTROL_END = 0x1f;
const C1_CONTROL_START = 0x80;
const C1_CONTROL_END = 0x9f;
const C1_DCS = 0x90;
const C1_SOS = 0x98;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const C1_OSC = 0x9d;
const C1_PM = 0x9e;
const C1_APC = 0x9f;
const HORIZONTAL_TAB_CODE = 0x09;
const LINE_FEED_CODE = 0x0a;
const CARRIAGE_RETURN_CODE = 0x0d;
const BELL_CODE = 0x07;
const ESCAPE_CSI = "[";
const ESCAPE_OSC = "]";
const ESCAPE_ST = "\\";
const ESCAPE_CONTROL_STRING_INTRODUCERS = new Set(["P", "X", "^", "_"]);
const C1_CONTROL_STRING_INTRODUCERS = new Set([C1_DCS, C1_SOS, C1_PM, C1_APC]);
const UTF8_ENCODING = "utf8";

export function sanitizeDisplayText(value: string): string {
	return sanitizeDisplayString(value);
}

export function sanitizeDisplayJson(value: JsonValue): JsonValue {
	if (typeof value === "string") return sanitizeDisplayString(value);
	if (Array.isArray(value)) return value.map(sanitizeDisplayJson);
	if (typeof value !== "object" || value === null) return value;

	return Object.fromEntries(
		Object.entries(value).map(
			([key, entry]) => [sanitizeDisplayString(key), sanitizeDisplayJson(entry)] as const,
		),
	);
}

export function sanitizeDisplayString(value: string): string {
	let sanitized = "";
	let index = 0;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		const controlEnd = consumeEncodedControl(value, index, code);
		if (controlEnd !== undefined) {
			index = controlEnd;
			continue;
		}
		if (code === CARRIAGE_RETURN_CODE) {
			sanitized += "\n";
			index = consumeCarriageReturn(value, index);
			continue;
		}
		if (isDiscardedControl(code)) {
			index += 1;
			continue;
		}
		sanitized += value[index];
		index += 1;
	}
	return sanitized;
}

function consumeEncodedControl(value: string, index: number, code: number): number | undefined {
	if (code === ESCAPE_CODE) return consumeEscapeSequence(value, index);
	if (code === C1_CSI) return consumeCsiSequence(value, index + 1);
	if (code === C1_OSC || C1_CONTROL_STRING_INTRODUCERS.has(code)) {
		return consumeControlString(value, index + 1);
	}
	return undefined;
}

function consumeCarriageReturn(value: string, index: number): number {
	return value.charCodeAt(index + 1) === LINE_FEED_CODE ? index + 2 : index + 1;
}

function isDiscardedControl(code: number): boolean {
	const isDiscardedC0 =
		code <= C0_CONTROL_END && code !== HORIZONTAL_TAB_CODE && code !== LINE_FEED_CODE;
	const isC1 = code >= C1_CONTROL_START && code <= C1_CONTROL_END;
	return isDiscardedC0 || code === DELETE_CODE || isC1;
}

function consumeEscapeSequence(value: string, escapeIndex: number): number {
	const introducer = value[escapeIndex + 1];
	if (introducer === undefined) return value.length;
	if (introducer === ESCAPE_CSI) return consumeCsiSequence(value, escapeIndex + 2);
	if (introducer === ESCAPE_OSC) return consumeControlString(value, escapeIndex + 2);
	if (ESCAPE_CONTROL_STRING_INTRODUCERS.has(introducer)) {
		return consumeControlString(value, escapeIndex + 2);
	}
	let index = escapeIndex + 1;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		if (code >= 0x20 && code <= 0x2f) {
			index += 1;
			continue;
		}
		if (code >= 0x30 && code <= 0x7e) return index + 1;
		return index;
	}
	return value.length;
}

function consumeCsiSequence(value: string, startIndex: number): number {
	let index = startIndex;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		index += 1;
		if (code >= 0x40 && code <= 0x7e) return index;
	}
	return value.length;
}

function consumeControlString(value: string, startIndex: number): number {
	let index = startIndex;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		if (code === C1_ST) return index + 1;
		if (code === BELL_CODE) return index + 1;
		if (code === ESCAPE_CODE && value[index + 1] === ESCAPE_ST) return index + 2;
		index += 1;
	}
	return value.length;
}

export function sanitizeBoundedDisplayLabel(value: string, maxBytes: number): string {
	return sanitizeBoundedDisplayString(
		sanitizeDisplayString(value).replace(DISPLAY_LABEL_LAYOUT_CONTROL_PATTERN, ""),
		maxBytes,
	);
}

export function sanitizeBoundedDisplayString(value: string, maxBytes: number): string {
	const sanitized = sanitizeDisplayString(value);
	if (Buffer.byteLength(sanitized, UTF8_ENCODING) <= maxBytes) return sanitized;
	const markBytes = Buffer.byteLength(DISPLAY_TRUNCATION_MARK, UTF8_ENCODING);
	if (maxBytes < markBytes) return "";
	const contentLimit = maxBytes - markBytes;
	let bytes = 0;
	let truncated = "";
	for (const character of sanitized) {
		const characterBytes = Buffer.byteLength(character, UTF8_ENCODING);
		if (bytes + characterBytes > contentLimit) break;
		truncated += character;
		bytes += characterBytes;
	}
	return truncated + DISPLAY_TRUNCATION_MARK;
}

export function boundCompatibilityError(value: string): string {
	return value.slice(0, COMPATIBILITY_ERROR_MAX_CHARACTERS);
}
