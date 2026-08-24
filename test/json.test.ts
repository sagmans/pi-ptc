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

test("snapshot rejects cycles", () => {
	const cycle: { self?: unknown } = {};
	cycle.self = cycle;
	assert.throws(() => snapshotJsonValue(cycle), /lossless JSON/);
});
