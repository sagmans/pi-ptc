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

function fail(): never {
	throw new Error(LOSSLESS_JSON_ERROR);
}

function snapshot(value: unknown, seen: WeakSet<object>): JsonValue {
	if (value === null) return null;
	if (typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") return snapshotNumber(value);
	if (typeof value === "object") return snapshotComposite(value, seen);
	return fail();
}

function snapshotNumber(value: number): number {
	if (!Number.isFinite(value) || Object.is(value, -0)) fail();
	return value;
}

function snapshotComposite(value: object, ancestors: WeakSet<object>): JsonValue {
	if (ancestors.has(value)) fail();
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return snapshotArray(value, ancestors);
		if (!isPlainRecord(value)) fail();
		return snapshotRecord(value, ancestors);
	} finally {
		ancestors.delete(value);
	}
}

function snapshotArray(value: readonly unknown[], ancestors: WeakSet<object>): JsonValue[] {
	const array: JsonValue[] = [];
	for (let index = 0; index < value.length; index += 1) {
		if (!Object.hasOwn(value, index)) fail();
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
