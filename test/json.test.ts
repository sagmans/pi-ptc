import { strict as assert } from "node:assert";
import test from "node:test";

import { LosslessJsonError, snapshotJsonValue } from "../src/json.ts";

test("snapshot keeps objects, arrays, and scalar JSON", () => {
	assert.deepEqual(snapshotJsonValue({ a: [1, "x", true, null] }), { a: [1, "x", true, null] });
});

test("snapshot reports the exact path and reason for invalid values", () => {
	assert.throws(
		() => snapshotJsonValue({ result: { rows: [{ value: undefined }] } }),
		(error: unknown) => {
			assert.ok(error instanceof LosslessJsonError);
			assert.equal(error.path, "$.result.rows[0].value");
			assert.equal(error.reason, "undefined");
			assert.equal(
				error.message,
				"value at $.result.rows[0].value is not lossless JSON: undefined is unsupported",
			);
			return true;
		},
	);
});

test("snapshot safely quotes non-identifier path segments", () => {
	assert.throws(() => snapshotJsonValue({ "quoted.key": { "\u202e": Number.NaN } }), {
		message: 'value at $["quoted.key"]["\\u202e"] is not lossless JSON: numbers must be finite',
	});
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
	assert.throws(() => snapshotJsonValue(new Date(0)), {
		message: "value at $ is not lossless JSON: object must be a plain object or dense array",
	});
	assert.throws(() => snapshotJsonValue(new Map([["safe", 1]])), /lossless JSON/);
});

test("snapshot classifies unreadable nested properties", () => {
	const source = Object.defineProperty({}, "blocked", {
		enumerable: true,
		get() {
			throw new Error("private value");
		},
	});
	assert.throws(() => snapshotJsonValue(source), {
		message: "value at $.blocked is not lossless JSON: property could not be read",
	});
});

test("snapshot classifies revoked nested proxies", () => {
	const revoked = Proxy.revocable({}, {});
	revoked.revoke();
	assert.throws(() => snapshotJsonValue({ blocked: revoked.proxy }), {
		message:
			"value at $.blocked is not lossless JSON: object must be a plain object or dense array",
	});
});

test("snapshot classifies unreadable property descriptors", () => {
	const source = new Proxy(
		{ blocked: 1 },
		{
			getOwnPropertyDescriptor() {
				throw new Error("private descriptor");
			},
		},
	);
	assert.throws(() => snapshotJsonValue(source), {
		message: "value at $.blocked is not lossless JSON: property could not be read",
	});
});

test("snapshot classifies unreadable array slots", () => {
	const source = new Proxy([1], {
		getOwnPropertyDescriptor() {
			throw new Error("private descriptor");
		},
	});
	assert.throws(() => snapshotJsonValue({ items: source }), {
		message: "value at $.items[0] is not lossless JSON: property could not be read",
	});
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
