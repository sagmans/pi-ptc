import { strict as assert } from "node:assert";
import test from "node:test";

import { SHIPPED_PTC_CONFIG } from "../src/config.ts";
import {
	createDeltaDetails,
	createSnapshotDetails,
	PTC_DETAIL_SCHEMA_VERSION,
	parseDispatchDetails,
	sanitizeDisplayJson,
} from "../src/dispatch-details.ts";

const DESCRIPTION = "inspect files";
const LEGACY_DESCRIPTION = "legacy";
const CONTROLLED_COMMAND = "before\u001b[2Jafter";
const SANITIZED_COMMAND = "beforeafter";
const COMPATIBILITY_ERROR_MAX_CHARACTERS = 256;
const LONG_EXECUTION_ERROR = "failure ".repeat(COMPATIBILITY_ERROR_MAX_CHARACTERS);
const HOSTILE_DETAILS_ERROR = "hostile details";
const PROTOTYPE_KEY = "__proto__";
const PROTOTYPE_PATH = "spoofed";
const PROTOTYPE_JSON = `{"${PROTOTYPE_KEY}":{"path":"${PROTOTYPE_PATH}"}}`;

const START_DISPATCH = {
	id: 2,
	name: "read" as const,
	args: { path: "b" },
	status: "start" as const,
};

const FINAL_DISPATCH = {
	id: 1,
	name: "read" as const,
	args: { path: "a" },
	status: "ok" as const,
	preview: "done",
};

test("display JSON strips terminal sequences recursively", () => {
	assert.deepEqual(sanitizeDisplayJson({ command: CONTROLLED_COMMAND }), {
		command: SANITIZED_COMMAND,
	});
});

test("display JSON preserves an own __proto__ key without changing the prototype", () => {
	const sanitized = sanitizeDisplayJson(JSON.parse(PROTOTYPE_JSON));
	const record = sanitized as { [key: string]: unknown };

	assert.equal(Object.getPrototypeOf(sanitized), Object.prototype);
	assert.equal(Object.hasOwn(record, PROTOTYPE_KEY), true);
	assert.deepEqual(record[PROTOTYPE_KEY], { path: PROTOTYPE_PATH });
	assert.equal(record.path, undefined);
});

test("version 2 delta contains one sanitized dispatch", () => {
	assert.deepEqual(
		createDeltaDetails(DESCRIPTION, {
			...START_DISPATCH,
			args: { command: CONTROLLED_COMMAND },
		}),
		{
			schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
			description: DESCRIPTION,
			mode: "delta",
			dispatches: [{ ...START_DISPATCH, args: { command: SANITIZED_COMMAND } }],
		},
	);
});

test("version 2 snapshot orders sanitized dispatches by id", () => {
	assert.deepEqual(createSnapshotDetails(DESCRIPTION, [START_DISPATCH, FINAL_DISPATCH]), {
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description: DESCRIPTION,
		mode: "snapshot",
		dispatches: [FINAL_DISPATCH, START_DISPATCH],
	});
});

test("legacy adjacent start and final records collapse to one stable id", () => {
	const parsed = parseDispatchDetails({
		description: LEGACY_DESCRIPTION,
		dispatches: [
			{ name: "read", args: { path: "a" }, status: "start" },
			{ name: "read", args: { path: "a" }, status: "ok", preview: "done" },
		],
	});

	assert.deepEqual(parsed, {
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description: LEGACY_DESCRIPTION,
		mode: "snapshot",
		dispatches: [FINAL_DISPATCH],
	});
});

test("version 2 delta rejects dispatch collections without exactly one record", () => {
	for (const dispatches of [[], [FINAL_DISPATCH, START_DISPATCH]]) {
		const parsed = parseDispatchDetails({
			schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
			description: DESCRIPTION,
			mode: "delta",
			dispatches,
		});

		assert.deepEqual(parsed.dispatches, []);
		assert.equal(typeof parsed.compatibilityError, "string");
	}
});

test("version 2 details omit duplicate dispatch ids", () => {
	const parsed = parseDispatchDetails({
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description: DESCRIPTION,
		mode: "snapshot",
		dispatches: [FINAL_DISPATCH, { ...START_DISPATCH, id: FINAL_DISPATCH.id }],
	});

	assert.deepEqual(parsed.dispatches, [FINAL_DISPATCH]);
	assert.equal(typeof parsed.compatibilityError, "string");
});

test("legacy details omit duplicate dispatch ids", () => {
	const parsed = parseDispatchDetails({
		description: LEGACY_DESCRIPTION,
		dispatches: [FINAL_DISPATCH, { ...START_DISPATCH, id: FINAL_DISPATCH.id }],
	});

	assert.deepEqual(parsed.dispatches, [FINAL_DISPATCH]);
	assert.equal(typeof parsed.compatibilityError, "string");
});

test("version 2 details reject dispatch collections over the shipped cap", () => {
	const dispatches = Array.from({ length: SHIPPED_PTC_CONFIG.maxDispatches + 1 }, (_, index) => ({
		...FINAL_DISPATCH,
		id: index + 1,
	}));
	const parsed = parseDispatchDetails({
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description: DESCRIPTION,
		mode: "snapshot",
		dispatches,
	});

	assert.deepEqual(parsed.dispatches, []);
	assert.equal(typeof parsed.compatibilityError, "string");
});

test("legacy details reject dispatch collections over the shipped cap", () => {
	const dispatches = Array.from({ length: SHIPPED_PTC_CONFIG.maxDispatches + 1 }, () => ({
		name: FINAL_DISPATCH.name,
		args: FINAL_DISPATCH.args,
		status: FINAL_DISPATCH.status,
	}));
	const parsed = parseDispatchDetails({ description: LEGACY_DESCRIPTION, dispatches });

	assert.deepEqual(parsed.dispatches, []);
	assert.equal(typeof parsed.compatibilityError, "string");
});

test("malformed dispatch records produce one bounded compatibility diagnostic", () => {
	const parsed = parseDispatchDetails({
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description: DESCRIPTION,
		mode: "snapshot",
		dispatches: [
			FINAL_DISPATCH,
			{ id: 2, name: "read", args: { path: undefined }, status: "ok" },
			{ id: 3, name: "unknown", args: null, status: "broken" },
		],
	});

	assert.deepEqual(parsed.dispatches, [FINAL_DISPATCH]);
	assert.equal(typeof parsed.compatibilityError, "string");
	assert.ok((parsed.compatibilityError?.length ?? 0) <= COMPATIBILITY_ERROR_MAX_CHARACTERS);
});

test("dispatch detail parsing never throws for hostile input", () => {
	const hostile = new Proxy(
		{},
		{
			has: () => {
				throw new Error(HOSTILE_DETAILS_ERROR);
			},
		},
	);

	assert.doesNotThrow(() => parseDispatchDetails(hostile));
	assert.equal(typeof parseDispatchDetails(hostile).compatibilityError, "string");
});

test("version 2 details survive a JSON round-trip", () => {
	const details = createSnapshotDetails(
		DESCRIPTION,
		[START_DISPATCH, FINAL_DISPATCH],
		LONG_EXECUTION_ERROR,
	);
	const restored = parseDispatchDetails(JSON.parse(JSON.stringify(details)));

	assert.deepEqual(restored, details);
});
