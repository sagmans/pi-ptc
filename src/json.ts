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
	if (typeof value === "number") {
		if (!Number.isFinite(value) || Object.is(value, -0)) fail();
		return value;
	}
	if (typeof value !== "object") fail();
	if (seen.has(value)) fail();
	seen.add(value);
	if (Array.isArray(value)) {
		return value.map((entry) => snapshot(entry, seen));
	}
	const record: { [key: string]: JsonValue } = {};
	for (const [key, entry] of Object.entries(value)) {
		record[key] = snapshot(entry, seen);
	}
	return record;
}

export function snapshotJsonValue(value: unknown): JsonValue {
	return snapshot(value, new WeakSet());
}
