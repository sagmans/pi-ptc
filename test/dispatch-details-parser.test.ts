import { strict as assert } from "node:assert";
import test from "node:test";

import { SHIPPED_PTC_CONFIG } from "../src/config.ts";
import {
	createDeltaDetails,
	createSnapshotDetails,
	PTC_DETAIL_SCHEMA_VERSION,
	parseDispatchDetails,
} from "../src/dispatch-details.ts";
import {
	COMPATIBILITY_ERROR_MAX_CHARACTERS,
	CONTROLLED_TOOL_NAMES,
	DESCRIPTION,
	FINAL_DISPATCH,
	GENERIC_TOOL_NAME,
	HOSTILE_DETAILS_ERROR,
	LEGACY_DESCRIPTION,
	LEGACY_NO_ID_FIXTURE,
	LONG_EXECUTION_ERROR,
	loadDispatchFixture,
	START_DISPATCH,
	VERSION_TWO_ERRORS_FIXTURE,
	VERSION_TWO_MALFORMED_FIXTURE,
	VERSION_TWO_SUCCESS_FIXTURE,
} from "./support/dispatch-details-harness.ts";

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

test("version 2 fixtures preserve native results, omissions, and independent errors", () => {
	const success = parseDispatchDetails(loadDispatchFixture(VERSION_TWO_SUCCESS_FIXTURE));
	const errors = parseDispatchDetails(loadDispatchFixture(VERSION_TWO_ERRORS_FIXTURE));

	const editDetails = success.dispatches[1]?.result?.details;

	assert.equal(success.dispatches.length, 4);
	assert.equal(success.dispatches[0]?.result?.content[0]?.text, "restored read content");
	assert.ok(typeof editDetails === "object" && editDetails !== null && !Array.isArray(editDetails));
	assert.equal(editDetails.diff, "@@ -1 +1 @@\n-old\n+new");
	assert.equal(success.dispatches[2]?.result?.content[1]?.mimeType, "image/png");
	assert.equal(success.dispatches[3]?.renderOmitted, "budget");
	assert.equal(success.dispatches[3]?.preview, "preview-only output");
	assert.equal(errors.dispatches[0]?.status, "err");
	assert.equal(errors.dispatches[0]?.preview, "nested fixture failure");
	assert.equal(errors.executionError, "outer fixture failure");
	assert.deepEqual(parseDispatchDetails(JSON.parse(JSON.stringify(success))), success);
	assert.deepEqual(parseDispatchDetails(JSON.parse(JSON.stringify(errors))), errors);
});

test("historical and malformed fixtures retain deterministic valid rows", () => {
	const legacy = parseDispatchDetails(loadDispatchFixture(LEGACY_NO_ID_FIXTURE));
	const malformed = parseDispatchDetails(loadDispatchFixture(VERSION_TWO_MALFORMED_FIXTURE));

	assert.deepEqual(
		legacy.dispatches.map((dispatch) => ({ id: dispatch.id, name: dispatch.name })),
		[
			{ id: 1, name: "read" },
			{ id: 2, name: "bash" },
		],
	);
	assert.equal(legacy.dispatches[0]?.preview, "legacy restored output");
	assert.equal(typeof legacy.compatibilityError, "string");
	assert.deepEqual(
		malformed.dispatches.map((dispatch) => dispatch.id),
		[1],
	);
	assert.equal(malformed.dispatches[0]?.preview, "valid row survives");
	assert.equal(typeof malformed.compatibilityError, "string");
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

test("arbitrary exact tool names round-trip through dispatch details", () => {
	const details = createDeltaDetails(DESCRIPTION, {
		id: 7,
		name: GENERIC_TOOL_NAME,
		args: { operation: "status" },
		status: "ok",
		preview: "complete",
	});
	const restored = parseDispatchDetails(JSON.parse(JSON.stringify(details)));

	assert.deepEqual(details.dispatches, [
		{
			id: 7,
			name: GENERIC_TOOL_NAME,
			args: { operation: "status" },
			status: "ok",
			preview: "complete",
		},
	]);
	assert.deepEqual(restored, details);
});

test("controlled exact tool names remain intact in persisted models", () => {
	const details = createSnapshotDetails(
		DESCRIPTION,
		CONTROLLED_TOOL_NAMES.map((name, index) => ({
			id: index + 1,
			name,
			args: {},
			status: "ok" as const,
		})),
	);
	const restored = parseDispatchDetails(JSON.parse(JSON.stringify(details)));

	assert.deepEqual(
		details.dispatches.map(({ name }) => name),
		CONTROLLED_TOOL_NAMES,
	);
	assert.deepEqual(
		restored.dispatches.map(({ name }) => name),
		CONTROLLED_TOOL_NAMES,
	);
});
