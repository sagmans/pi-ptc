import { strict as assert } from "node:assert";
import test from "node:test";

import { SHIPPED_PTC_CONFIG } from "../src/config.ts";
import {
	createDeltaDetails,
	createSnapshotDetails,
	PTC_DETAIL_SCHEMA_VERSION,
} from "../src/dispatch-details.ts";
import {
	CONTROLLED_COMMAND,
	DESCRIPTION,
	FINAL_DISPATCH,
	OVERSIZED_ARGUMENT_TEXT,
	OVERSIZED_DESCRIPTION_TAIL,
	OVERSIZED_ERROR_TAIL,
	SANITIZED_COMMAND,
	START_DISPATCH,
} from "./support/dispatch-details-harness.ts";

test("version 2 delta contains one sanitized dispatch", () => {
	assert.deepEqual(
		createDeltaDetails(DESCRIPTION, {
			...START_DISPATCH,
			args: { path: CONTROLLED_COMMAND },
		}),
		{
			schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
			description: DESCRIPTION,
			mode: "delta",
			dispatches: [{ ...START_DISPATCH, args: { path: SANITIZED_COMMAND } }],
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

test("persisted details bound descriptions, errors, and tool arguments together", () => {
	const oversizedDescription = `${OVERSIZED_ARGUMENT_TEXT}${OVERSIZED_DESCRIPTION_TAIL}`;
	const oversizedError = `${OVERSIZED_ARGUMENT_TEXT}${OVERSIZED_ERROR_TAIL}`;
	const details = createSnapshotDetails(
		oversizedDescription,
		Array.from({ length: 3 }, (_, index) => ({
			id: index + 1,
			name: "write" as const,
			args: { path: `file-${index}.txt`, content: OVERSIZED_ARGUMENT_TEXT },
			status: "ok" as const,
		})),
		oversizedError,
	);
	const serialized = JSON.stringify(details);

	assert.ok(Buffer.byteLength(serialized, "utf8") <= SHIPPED_PTC_CONFIG.maxPersistedDetailsBytes);
	assert.equal(serialized.includes(OVERSIZED_DESCRIPTION_TAIL), false);
	assert.equal(serialized.includes(OVERSIZED_ERROR_TAIL), false);
	assert.equal(serialized.includes(OVERSIZED_ARGUMENT_TEXT), false);
	assert.deepEqual(
		details.dispatches.map((dispatch) => dispatch.args),
		[{ path: "file-0.txt" }, { path: "file-1.txt" }, { path: "file-2.txt" }],
	);
});
