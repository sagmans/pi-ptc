import { strict as assert } from "node:assert";
import test from "node:test";

import type { DispatchRenderResult } from "../src/bridge.ts";
import {
	createDeltaDetails,
	createSnapshotDetails,
	PTC_DETAIL_SCHEMA_VERSION,
	parseDispatchDetails,
} from "../src/dispatch-details.ts";
import {
	COMPATIBILITY_ERROR_MAX_CHARACTERS,
	CONTROLLED_COMMAND,
	CONTROLLED_RESULT_KEY,
	DESCRIPTION,
	FINAL_DISPATCH,
	FULL_RENDER_RESULT,
	HOSTILE_DETAILS_ERROR,
	HOSTILE_RESULT_ERROR,
	INCOMPATIBLE_RENDER_VALUE,
	OMITTED_RENDER_DATA,
	OMITTED_RENDER_RESULT,
	OMITTED_RENDER_TEXT,
	OVERSIZED_RENDER_VALUE,
	PREFLIGHT_RENDER_BUDGET_BYTES,
	RENDER_DETAILS_BUDGET_BYTES,
	SANITIZED_COMMAND,
	SANITIZED_RESULT_KEY,
	START_DISPATCH,
} from "./support/dispatch-details-harness.ts";

test("snapshot render projections omit whole results after the byte budget is exhausted", () => {
	const details = createSnapshotDetails(
		DESCRIPTION,
		[
			{ ...FINAL_DISPATCH, result: FULL_RENDER_RESULT },
			{
				...START_DISPATCH,
				status: "ok",
				preview: "omitted preview",
				result: OMITTED_RENDER_RESULT,
			},
			{
				...START_DISPATCH,
				id: 3,
				status: "ok",
				preview: "later preview",
				result: { content: [], isError: false },
			},
		],
		undefined,
		RENDER_DETAILS_BUDGET_BYTES,
	);

	assert.deepEqual(details.dispatches, [
		{ ...FINAL_DISPATCH, result: FULL_RENDER_RESULT },
		{
			...START_DISPATCH,
			status: "ok",
			preview: "omitted preview",
			renderOmitted: "budget",
		},
		{
			...START_DISPATCH,
			id: 3,
			status: "ok",
			preview: "later preview",
			renderOmitted: "budget",
		},
	]);
	const serialized = JSON.stringify(details);
	assert.equal(serialized.includes(OMITTED_RENDER_TEXT), false);
	assert.equal(serialized.includes(OMITTED_RENDER_DATA), false);
	assert.deepEqual(parseDispatchDetails(JSON.parse(serialized)), details);
});

test("render projection accepts explicit undefined fields and sanitizes controls recursively", () => {
	const details = createDeltaDetails(DESCRIPTION, {
		...FINAL_DISPATCH,
		result: {
			content: [
				{
					type: `text${CONTROLLED_COMMAND}`,
					text: undefined,
					data: undefined,
					mimeType: undefined,
				},
			],
			details: {
				[CONTROLLED_RESULT_KEY]: [CONTROLLED_COMMAND],
			},
			isError: false,
		},
	});

	assert.deepEqual(details.dispatches, [
		{
			...FINAL_DISPATCH,
			result: {
				content: [{ type: `text${SANITIZED_COMMAND}` }],
				details: { [SANITIZED_RESULT_KEY]: [SANITIZED_COMMAND] },
				isError: false,
			},
		},
	]);
	assert.equal(details.compatibilityError, undefined);
});

test("render projection omits only hostile or incompatible results", () => {
	const cyclicDetails: { self?: unknown } = {};
	cyclicDetails.self = cyclicDetails;
	const hostileDetails = new Proxy(
		{},
		{
			ownKeys: () => {
				throw new Error(HOSTILE_DETAILS_ERROR);
			},
		},
	);
	const results = [
		{ content: [], details: cyclicDetails, isError: false },
		{ content: [], details: hostileDetails, isError: false },
		{
			content: [{ type: "text", text: INCOMPATIBLE_RENDER_VALUE }],
			isError: false,
		},
	] as unknown as DispatchRenderResult[];

	for (const result of results) {
		let details: ReturnType<typeof createDeltaDetails> | undefined;
		assert.doesNotThrow(() => {
			details = createDeltaDetails(DESCRIPTION, { ...FINAL_DISPATCH, result });
		});
		assert.deepEqual(details?.dispatches, [{ ...FINAL_DISPATCH, renderOmitted: "incompatible" }]);
		assert.ok((details?.compatibilityError?.length ?? 0) > 0);
		assert.ok((details?.compatibilityError?.length ?? 0) <= COMPATIBILITY_ERROR_MAX_CHARACTERS);
	}
});

test("a hostile live result accessor omits only the render projection", () => {
	const dispatch = Object.defineProperty({ ...FINAL_DISPATCH }, "result", {
		enumerable: true,
		get() {
			throw new Error(HOSTILE_RESULT_ERROR);
		},
	}) as unknown as Parameters<typeof createDeltaDetails>[1];
	let details: ReturnType<typeof createDeltaDetails> | undefined;

	assert.doesNotThrow(() => {
		details = createDeltaDetails(DESCRIPTION, dispatch);
	});
	assert.deepEqual(details?.dispatches, [{ ...FINAL_DISPATCH, renderOmitted: "incompatible" }]);
	assert.ok((details?.compatibilityError?.length ?? 0) > 0);
});

test("a hostile persisted result accessor preserves the base dispatch", () => {
	const dispatch = Object.defineProperty({ ...FINAL_DISPATCH }, "result", {
		enumerable: true,
		get() {
			throw new Error(HOSTILE_RESULT_ERROR);
		},
	});
	const parsed = parseDispatchDetails({
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description: DESCRIPTION,
		mode: "snapshot",
		dispatches: [dispatch],
	});

	assert.deepEqual(parsed.dispatches, [{ ...FINAL_DISPATCH, renderOmitted: "incompatible" }]);
	assert.ok((parsed.compatibilityError?.length ?? 0) > 0);
});

test("oversized render payloads stop before later hostile data is accessed", () => {
	for (const field of ["text", "data"] as const) {
		let detailsReads = 0;
		const result = {
			content: [{ type: field === "text" ? "text" : "image", [field]: OVERSIZED_RENDER_VALUE }],
			get details() {
				detailsReads += 1;
				throw new Error(HOSTILE_DETAILS_ERROR);
			},
			isError: false,
		} as DispatchRenderResult;

		const details = createDeltaDetails(
			DESCRIPTION,
			{ ...FINAL_DISPATCH, result },
			PREFLIGHT_RENDER_BUDGET_BYTES,
		);

		assert.deepEqual(details.dispatches, [{ ...FINAL_DISPATCH, renderOmitted: "budget" }]);
		assert.equal(detailsReads, 0);
	}

	let trailingReads = 0;
	const rawDetails = Object.defineProperties(
		{},
		{
			first: { enumerable: true, value: OVERSIZED_RENDER_VALUE },
			second: {
				enumerable: true,
				get() {
					trailingReads += 1;
					throw new Error(HOSTILE_DETAILS_ERROR);
				},
			},
		},
	);
	const details = createDeltaDetails(
		DESCRIPTION,
		{
			...FINAL_DISPATCH,
			result: { content: [], details: rawDetails, isError: false },
		},
		PREFLIGHT_RENDER_BUDGET_BYTES,
	);

	assert.deepEqual(details.dispatches, [{ ...FINAL_DISPATCH, renderOmitted: "budget" }]);
	assert.equal(trailingReads, 0);
});

test("parsing an incompatible persisted result preserves its base dispatch", () => {
	const parsed = parseDispatchDetails({
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description: DESCRIPTION,
		mode: "snapshot",
		dispatches: [
			{
				...FINAL_DISPATCH,
				result: {
					content: [{ type: "text", text: INCOMPATIBLE_RENDER_VALUE }],
					isError: false,
				},
			},
		],
	});

	assert.deepEqual(parsed.dispatches, [{ ...FINAL_DISPATCH, renderOmitted: "incompatible" }]);
	assert.ok((parsed.compatibilityError?.length ?? 0) > 0);
});
