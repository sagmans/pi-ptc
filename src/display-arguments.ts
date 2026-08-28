import { type CoreToolName, isCoreToolName } from "./config.ts";
import { sanitizeBoundedDisplayString, sanitizeDisplayString } from "./display-sanitizer.ts";
import type { JsonValue } from "./json.ts";

const DISPLAY_ARGUMENT_MAX_BYTES = 8192;
const DISPLAY_ARGUMENT_STRING_MAX_BYTES = 4096;
const GENERIC_DISPLAY_ARGUMENT_KEY_MAX_BYTES = 256;
const GENERIC_DISPLAY_ARGUMENT_MAX_DEPTH = 8;
const GENERIC_DISPLAY_ARGUMENT_MAX_ENTRIES = 64;
const LIVE_WRITE_CONTENT_MAX_BYTES = 3072;
const LIVE_EDIT_ENTRY_MAX_COUNT = 8;
const LIVE_EDIT_TEXT_MAX_BYTES = 192;
const UTF8_ENCODING = "utf8";
const OMITTED_GENERIC_ARGUMENT = Symbol("omitted-generic-argument");
const CREDENTIAL_KEY_SEPARATOR_PATTERN = /[^a-z0-9]/gi;
const CREDENTIAL_KEY_WORD_BOUNDARY_PATTERN = /([a-z0-9])([A-Z])/g;
const CREDENTIAL_KEY_WORD_SEPARATOR_PATTERN = /[^a-z0-9]+/;
const CREDENTIAL_KEYS = new Set([
	"password",
	"secret",
	"token",
	"authorization",
	"cookie",
	"clientsecret",
	"oauthcode",
	"redirecturl",
]);
const CREDENTIAL_KEY_WORDS = new Set(["password", "secret", "token", "authorization", "cookie"]);

export const DISPLAY_ARGUMENT_REDACTION_MARKER = "[REDACTED]";

const DISPLAY_ARGUMENT_KEYS = Object.freeze({
	bash: ["command", "timeout"],
	edit: ["path"],
	find: ["pattern", "path", "limit"],
	grep: ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"],
	ls: ["path", "limit"],
	read: ["path", "offset", "limit"],
	write: ["path"],
} as const satisfies Record<CoreToolName, readonly string[]>);

type GenericProjectionState = {
	remainingEntries: number;
	ancestors: WeakSet<object>;
};

export function projectDisplayArguments(name: string, value: unknown): JsonValue {
	return isCoreToolName(name)
		? projectCoreDisplayArguments(name, value)
		: projectGenericDisplayArguments(value);
}

function projectCoreDisplayArguments(name: CoreToolName, value: unknown): JsonValue {
	if (!isUnknownRecord(value)) return {};
	const projected: { [key: string]: JsonValue } = {};
	for (const key of DISPLAY_ARGUMENT_KEYS[name]) {
		let entry: unknown;
		try {
			entry = Reflect.get(value, key);
		} catch {
			continue;
		}
		const sanitized = projectCoreDisplayArgument(entry);
		if (sanitized === undefined) continue;
		setProjectedArgument(projected, key, sanitized);
	}
	return projected;
}

function projectCoreDisplayArgument(entry: unknown): JsonValue | undefined {
	if (typeof entry === "string") {
		return sanitizeBoundedDisplayString(entry, DISPLAY_ARGUMENT_STRING_MAX_BYTES);
	}
	if (entry === null || typeof entry === "boolean") return entry;
	if (typeof entry === "number" && Number.isFinite(entry) && !Object.is(entry, -0)) return entry;
	return undefined;
}

function projectGenericDisplayArguments(value: unknown): JsonValue {
	const projected = projectGenericDisplayArgument(value, 0, {
		remainingEntries: GENERIC_DISPLAY_ARGUMENT_MAX_ENTRIES,
		ancestors: new WeakSet(),
	});
	return projected === OMITTED_GENERIC_ARGUMENT ? {} : projected;
}

function projectGenericDisplayArgument(
	value: unknown,
	depth: number,
	state: GenericProjectionState,
): JsonValue | typeof OMITTED_GENERIC_ARGUMENT {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		return sanitizeBoundedDisplayString(value, DISPLAY_ARGUMENT_STRING_MAX_BYTES);
	}
	if (typeof value === "number") {
		return Number.isFinite(value) && !Object.is(value, -0) ? value : OMITTED_GENERIC_ARGUMENT;
	}
	if (typeof value !== "object" || depth >= GENERIC_DISPLAY_ARGUMENT_MAX_DEPTH) {
		return OMITTED_GENERIC_ARGUMENT;
	}
	if (state.ancestors.has(value)) return OMITTED_GENERIC_ARGUMENT;
	state.ancestors.add(value);
	try {
		return projectGenericDisplayComposite(value, depth, state);
	} finally {
		state.ancestors.delete(value);
	}
}

function projectGenericDisplayComposite(
	value: object,
	depth: number,
	state: GenericProjectionState,
): JsonValue | typeof OMITTED_GENERIC_ARGUMENT {
	try {
		return Array.isArray(value)
			? projectGenericDisplayArray(value, depth, state)
			: projectGenericDisplayRecord(value, depth, state);
	} catch {
		return OMITTED_GENERIC_ARGUMENT;
	}
}

function projectGenericDisplayArray(
	value: readonly unknown[],
	depth: number,
	state: GenericProjectionState,
): JsonValue[] {
	const projected: JsonValue[] = [];
	let length: number;
	try {
		length = value.length;
	} catch {
		return projected;
	}
	for (let index = 0; index < length && state.remainingEntries > 0; index += 1) {
		state.remainingEntries -= 1;
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
		} catch {
			continue;
		}
		if (!descriptor || !("value" in descriptor)) continue;
		const entry = projectGenericDisplayArgument(descriptor.value, depth + 1, state);
		if (entry === OMITTED_GENERIC_ARGUMENT) continue;
		projected.push(entry);
		if (!fitsDisplayArgumentBudget(projected)) projected.pop();
	}
	return projected;
}

function projectGenericDisplayRecord(
	value: object,
	depth: number,
	state: GenericProjectionState,
): { [key: string]: JsonValue } {
	const projected: { [key: string]: JsonValue } = {};
	let keys: string[];
	try {
		keys = Object.keys(value);
	} catch {
		return projected;
	}
	for (const key of keys) {
		if (state.remainingEntries <= 0) break;
		state.remainingEntries -= 1;
		const sanitizedKey = sanitizeBoundedDisplayString(
			sanitizeDisplayString(key),
			GENERIC_DISPLAY_ARGUMENT_KEY_MAX_BYTES,
		);
		if (isCredentialKey(key)) {
			setProjectedArgument(projected, sanitizedKey, DISPLAY_ARGUMENT_REDACTION_MARKER);
			continue;
		}
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Reflect.getOwnPropertyDescriptor(value, key);
		} catch {
			continue;
		}
		if (!descriptor || !("value" in descriptor)) continue;
		const entry = projectGenericDisplayArgument(descriptor.value, depth + 1, state);
		if (entry === OMITTED_GENERIC_ARGUMENT) continue;
		setProjectedArgument(projected, sanitizedKey, entry);
	}
	return projected;
}

function isCredentialKey(key: string): boolean {
	const normalized = key.replace(CREDENTIAL_KEY_SEPARATOR_PATTERN, "").toLowerCase();
	if (CREDENTIAL_KEYS.has(normalized)) return true;
	const words = key
		.replace(CREDENTIAL_KEY_WORD_BOUNDARY_PATTERN, "$1 $2")
		.toLowerCase()
		.split(CREDENTIAL_KEY_WORD_SEPARATOR_PATTERN);
	return words.some((word) => CREDENTIAL_KEY_WORDS.has(word));
}

export function projectLiveDisplayArguments(name: string, value: unknown): JsonValue {
	const projected = projectDisplayArguments(name, value);
	if (!isCoreToolName(name) || !isUnknownRecord(projected) || !isUnknownRecord(value)) {
		return projected;
	}
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
	if (!fitsDisplayArgumentBudget(projected)) Reflect.deleteProperty(projected, key);
}

function fitsDisplayArgumentBudget(value: JsonValue): boolean {
	try {
		return Buffer.byteLength(JSON.stringify(value), UTF8_ENCODING) <= DISPLAY_ARGUMENT_MAX_BYTES;
	} catch {
		return false;
	}
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
