import { strict as assert } from "node:assert";
import test from "node:test";

import { snapshotJsonValue } from "../src/json.ts";

test("snapshot keeps objects, arrays, and scalar JSON", () => {
	assert.deepEqual(snapshotJsonValue({ a: [1, "x", true, null] }), { a: [1, "x", true, null] });
});

test("snapshot rejects undefined", () => {
	assert.throws(() => snapshotJsonValue({ a: undefined }), /lossless JSON/);
});

test("snapshot rejects NaN and Infinity", () => {
	assert.throws(() => snapshotJsonValue(Number.NaN), /lossless JSON/);
	assert.throws(() => snapshotJsonValue(Number.POSITIVE_INFINITY), /lossless JSON/);
});

test("snapshot rejects negative zero", () => {
	assert.throws(() => snapshotJsonValue(-0), /lossless JSON/);
});

test("snapshot preserves an own __proto__ key without prototype mutation", () => {
	const source = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
	const snapshot = snapshotJsonValue(source);
	const record = snapshot as { [key: string]: unknown };

	assert.equal(Object.getPrototypeOf(snapshot), Object.prototype);
	assert.equal(Object.hasOwn(record, "__proto__"), true);
	assert.deepEqual(Reflect.get(record, "__proto__"), { polluted: true });
	assert.equal(record.polluted, undefined);
});

test("snapshot accepts null-prototype records", () => {
	const source = Object.create(null) as Record<string, unknown>;
	source.safe = { value: 1 };

	assert.deepEqual(snapshotJsonValue(source), { safe: { value: 1 } });
});

test("snapshot rejects exotic records", () => {
	assert.throws(() => snapshotJsonValue(new Date(0)), /lossless JSON/);
	assert.throws(() => snapshotJsonValue(new Map([["safe", 1]])), /lossless JSON/);
});

test("snapshot rejects sparse arrays", () => {
	const sparse: unknown[] = [];
	sparse.length = 2;
	sparse[1] = "present";
	assert.throws(() => snapshotJsonValue(sparse), /lossless JSON/);
});

test("snapshot rejects cycles", () => {
	const cycle: { self?: unknown } = {};
	cycle.self = cycle;
	assert.throws(() => snapshotJsonValue(cycle), /lossless JSON/);
});

test("snapshot clones shared non-cyclic references", () => {
	const shared = { value: 1 };
	assert.deepEqual(snapshotJsonValue({ first: shared, second: shared }), {
		first: { value: 1 },
		second: { value: 1 },
	});
});
