// Binding args and program results must survive a JSON round-trip unchanged.
// JSON.stringify quietly drops undefined and collapses -0 / NaN, so we reject
// those before they cross the worker boundary.

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

const UNSAFE_JSON_LITERAL_CODE_UNIT_PATTERN =
	/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f]/gu;

export function renderSafeJsonStringLiteral(value: string): string {
	return JSON.stringify(value).replace(UNSAFE_JSON_LITERAL_CODE_UNIT_PATTERN, (character) => {
		const codeUnit = character.charCodeAt(0).toString(16).padStart(4, "0");
		return `\\u${codeUnit}`;
	});
}

const LOSSLESS_JSON_ERROR = "is not lossless JSON";
const ROOT_JSON_PATH = "$";
const ASCII_IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const LOSSLESS_JSON_REASONS = Object.freeze({
	cycle: "cyclic references are unsupported",
	nonFiniteNumber: "numbers must be finite",
	negativeZero: "negative zero is unsupported",
	propertyAccess: "property could not be read",
	sparseArray: "arrays must be dense",
	undefined: "undefined is unsupported",
	unsupportedObject: "object must be a plain object or dense array",
	unsupportedType: "functions, symbols, and bigint are unsupported",
} as const);

export type LosslessJsonReason = keyof typeof LOSSLESS_JSON_REASONS;

export class LosslessJsonError extends Error {
	readonly path: string;
	readonly reason: LosslessJsonReason;

	constructor(reason: LosslessJsonReason, path: string) {
		super(`value at ${path} ${LOSSLESS_JSON_ERROR}: ${LOSSLESS_JSON_REASONS[reason]}`);
		this.name = "LosslessJsonError";
		this.path = path;
		this.reason = reason;
	}
}

function fail(reason: LosslessJsonReason, path: string): never {
	throw new LosslessJsonError(reason, path);
}

function snapshot(value: unknown, seen: WeakSet<object>, path: string): JsonValue {
	if (value === null) return null;
	if (typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") return snapshotNumber(value, path);
	if (typeof value === "object") return snapshotComposite(value, seen, path);
	return fail(value === undefined ? "undefined" : "unsupportedType", path);
}

function snapshotNumber(value: number, path: string): number {
	if (!Number.isFinite(value)) fail("nonFiniteNumber", path);
	if (Object.is(value, -0)) fail("negativeZero", path);
	return value;
}

function snapshotComposite(value: object, ancestors: WeakSet<object>, path: string): JsonValue {
	if (ancestors.has(value)) fail("cycle", path);
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return snapshotArray(value, ancestors, path);
		if (!isPlainRecord(value)) fail("unsupportedObject", path);
		return snapshotRecord(value, ancestors, path);
	} catch (error) {
		if (error instanceof LosslessJsonError) throw error;
		return fail("unsupportedObject", path);
	} finally {
		ancestors.delete(value);
	}
}

function snapshotArray(
	value: readonly unknown[],
	ancestors: WeakSet<object>,
	path: string,
): JsonValue[] {
	const array: JsonValue[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const itemPath = `${path}[${index}]`;
		if (!hasOwnJsonProperty(value, index, itemPath)) fail("sparseArray", itemPath);
		array.push(snapshot(readValue(value, index, itemPath), ancestors, itemPath));
	}
	return array;
}

function snapshotRecord(
	value: Record<string, unknown>,
	ancestors: WeakSet<object>,
	path: string,
): { [key: string]: JsonValue } {
	const record: { [key: string]: JsonValue } = {};
	for (const key of enumerableOwnStringKeys(value, path)) {
		const propertyPath = appendPropertyPath(path, key);
		Object.defineProperty(record, key, {
			configurable: true,
			enumerable: true,
			value: snapshot(readValue(value, key, propertyPath), ancestors, propertyPath),
			writable: true,
		});
	}
	return record;
}

function enumerableOwnStringKeys(value: object, path: string): string[] {
	let keys: (string | symbol)[];
	try {
		keys = Reflect.ownKeys(value);
	} catch {
		return fail("propertyAccess", path);
	}
	return keys.filter((key): key is string => {
		if (typeof key !== "string") return false;
		return (
			readOwnPropertyDescriptor(value, key, appendPropertyPath(path, key))?.enumerable === true
		);
	});
}

function hasOwnJsonProperty(value: object, key: string | number, path: string): boolean {
	return readOwnPropertyDescriptor(value, key, path) !== undefined;
}

function readOwnPropertyDescriptor(
	value: object,
	key: string | number,
	path: string,
): PropertyDescriptor | undefined {
	try {
		return Reflect.getOwnPropertyDescriptor(value, key);
	} catch {
		return fail("propertyAccess", path);
	}
}

function readValue(value: object, key: string | number, path: string): unknown {
	try {
		return Reflect.get(value, key);
	} catch {
		return fail("propertyAccess", path);
	}
}

function appendPropertyPath(path: string, key: string): string {
	return ASCII_IDENTIFIER_PATTERN.test(key)
		? `${path}.${key}`
		: `${path}[${renderSafeJsonStringLiteral(key)}]`;
}

function isPlainRecord(value: object): value is Record<string, unknown> {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function snapshotJsonValue(value: unknown): JsonValue {
	return snapshot(value, new WeakSet(), ROOT_JSON_PATH);
}
