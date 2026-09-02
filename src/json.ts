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

const LOSSLESS_JSON_ERROR = "value is not lossless JSON";
const LOSSLESS_JSON_REASONS = Object.freeze({
	cycle: "cyclic references are unsupported",
	nonFiniteNumber: "numbers must be finite",
	negativeZero: "negative zero is unsupported",
	sparseArray: "arrays must be dense",
	undefined: "undefined is unsupported",
	unsupportedObject: "object must be a plain object or dense array",
	unsupportedType: "functions, symbols, and bigint are unsupported",
} as const);

export type LosslessJsonReason = keyof typeof LOSSLESS_JSON_REASONS;

export class LosslessJsonError extends Error {
	readonly reason: LosslessJsonReason;

	constructor(reason: LosslessJsonReason) {
		super(`${LOSSLESS_JSON_ERROR}: ${LOSSLESS_JSON_REASONS[reason]}`);
		this.name = "LosslessJsonError";
		this.reason = reason;
	}
}

function fail(reason: LosslessJsonReason): never {
	throw new LosslessJsonError(reason);
}

function snapshot(value: unknown, seen: WeakSet<object>): JsonValue {
	if (value === null) return null;
	if (typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") return snapshotNumber(value);
	if (typeof value === "object") return snapshotComposite(value, seen);
	return fail(value === undefined ? "undefined" : "unsupportedType");
}

function snapshotNumber(value: number): number {
	if (!Number.isFinite(value)) fail("nonFiniteNumber");
	if (Object.is(value, -0)) fail("negativeZero");
	return value;
}

function snapshotComposite(value: object, ancestors: WeakSet<object>): JsonValue {
	if (ancestors.has(value)) fail("cycle");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return snapshotArray(value, ancestors);
		if (!isPlainRecord(value)) fail("unsupportedObject");
		return snapshotRecord(value, ancestors);
	} finally {
		ancestors.delete(value);
	}
}

function snapshotArray(value: readonly unknown[], ancestors: WeakSet<object>): JsonValue[] {
	const array: JsonValue[] = [];
	for (let index = 0; index < value.length; index += 1) {
		if (!Object.hasOwn(value, index)) fail("sparseArray");
		array.push(snapshot(Reflect.get(value, index), ancestors));
	}
	return array;
}

function snapshotRecord(
	value: Record<string, unknown>,
	ancestors: WeakSet<object>,
): { [key: string]: JsonValue } {
	const record: { [key: string]: JsonValue } = {};
	for (const key of Object.keys(value)) {
		Object.defineProperty(record, key, {
			configurable: true,
			enumerable: true,
			value: snapshot(Reflect.get(value, key), ancestors),
			writable: true,
		});
	}
	return record;
}

function isPlainRecord(value: object): value is Record<string, unknown> {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function snapshotJsonValue(value: unknown): JsonValue {
	return snapshot(value, new WeakSet());
}
