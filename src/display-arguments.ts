import type { CoreToolName } from "./config.ts";
import { sanitizeBoundedDisplayString } from "./display-sanitizer.ts";
import type { JsonValue } from "./json.ts";

const DISPLAY_ARGUMENT_MAX_BYTES = 8192;
const DISPLAY_ARGUMENT_STRING_MAX_BYTES = 4096;
const LIVE_WRITE_CONTENT_MAX_BYTES = 3072;
const LIVE_EDIT_ENTRY_MAX_COUNT = 8;
const LIVE_EDIT_TEXT_MAX_BYTES = 192;
const UTF8_ENCODING = "utf8";
const DISPLAY_ARGUMENT_KEYS = Object.freeze({
	bash: ["command", "timeout"],
	edit: ["path"],
	find: ["pattern", "path", "limit"],
	grep: ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"],
	ls: ["path", "limit"],
	read: ["path", "offset", "limit"],
	write: ["path"],
} as const satisfies Record<CoreToolName, readonly string[]>);

export function projectDisplayArguments(name: CoreToolName, value: unknown): JsonValue {
	if (!isUnknownRecord(value)) return {};
	const projected: { [key: string]: JsonValue } = {};
	for (const key of DISPLAY_ARGUMENT_KEYS[name]) {
		let entry: unknown;
		try {
			entry = Reflect.get(value, key);
		} catch {
			continue;
		}
		const sanitized = projectDisplayArgument(entry);
		if (sanitized === undefined) continue;
		Object.defineProperty(projected, key, {
			configurable: true,
			enumerable: true,
			value: sanitized,
			writable: true,
		});
		if (Buffer.byteLength(JSON.stringify(projected), UTF8_ENCODING) > DISPLAY_ARGUMENT_MAX_BYTES) {
			Reflect.deleteProperty(projected, key);
		}
	}
	return projected;
}

function projectDisplayArgument(entry: unknown): JsonValue | undefined {
	if (typeof entry === "string") {
		return sanitizeBoundedDisplayString(entry, DISPLAY_ARGUMENT_STRING_MAX_BYTES);
	}
	if (entry === null || typeof entry === "boolean") return entry;
	if (typeof entry === "number" && Number.isFinite(entry) && !Object.is(entry, -0)) return entry;
	return undefined;
}

export function projectLiveDisplayArguments(name: CoreToolName, value: unknown): JsonValue {
	const projected = projectDisplayArguments(name, value) as { [key: string]: JsonValue };
	if (!isUnknownRecord(value)) return projected;
	try {
		switch (name) {
			case "write":
				projectLiveWriteArguments(projected, value);
				break;
			case "edit":
				projectLiveEditArguments(projected, value);
				break;
			case "bash":
			case "find":
			case "grep":
			case "ls":
			case "read":
				break;
			default: {
				const _never: never = name;
				throw new Error(String(_never));
			}
		}
	} catch {
		return projected;
	}
	return projected;
}

function projectLiveWriteArguments(
	projected: { [key: string]: JsonValue },
	value: Record<string, unknown>,
): void {
	const content = Reflect.get(value, "content");
	if (typeof content !== "string") return;
	const sanitized = sanitizeBoundedDisplayString(content, LIVE_WRITE_CONTENT_MAX_BYTES);
	if (sanitized === content) setProjectedArgument(projected, "content", sanitized);
}

function projectLiveEditArguments(
	projected: { [key: string]: JsonValue },
	value: Record<string, unknown>,
): void {
	const rawEdits = Reflect.get(value, "edits");
	if (!isBoundedEditCollection(rawEdits)) return;
	const edits: JsonValue[] = [];
	for (const rawEdit of rawEdits) {
		const edit = projectLiveEdit(rawEdit);
		if (!edit) return;
		edits.push(edit);
	}
	setProjectedArgument(projected, "edits", edits);
}

function isBoundedEditCollection(value: unknown): value is unknown[] {
	return Array.isArray(value) && value.length > 0 && value.length <= LIVE_EDIT_ENTRY_MAX_COUNT;
}

function projectLiveEdit(value: unknown): { oldText: string; newText: string } | undefined {
	if (!isUnknownRecord(value)) return undefined;
	const oldText = Reflect.get(value, "oldText");
	const newText = Reflect.get(value, "newText");
	if (typeof oldText !== "string" || typeof newText !== "string") return undefined;
	const sanitizedOldText = sanitizeBoundedDisplayString(oldText, LIVE_EDIT_TEXT_MAX_BYTES);
	const sanitizedNewText = sanitizeBoundedDisplayString(newText, LIVE_EDIT_TEXT_MAX_BYTES);
	if (sanitizedOldText !== oldText || sanitizedNewText !== newText) return undefined;
	return { oldText: sanitizedOldText, newText: sanitizedNewText };
}

function setProjectedArgument(
	projected: { [key: string]: JsonValue },
	key: string,
	value: JsonValue,
): void {
	Object.defineProperty(projected, key, {
		configurable: true,
		enumerable: true,
		value,
		writable: true,
	});
	if (Buffer.byteLength(JSON.stringify(projected), UTF8_ENCODING) > DISPLAY_ARGUMENT_MAX_BYTES) {
		Reflect.deleteProperty(projected, key);
	}
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
