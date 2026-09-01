import { strict as assert } from "node:assert";
import test from "node:test";

import { createDeltaDetails, sanitizeDisplayJson } from "../src/dispatch-details.ts";
import {
	CONTROLLED_COMMAND,
	DESCRIPTION,
	EXTENDED_CONTROLLED_TEXT,
	EXTENDED_SANITIZED_TEXT,
	PROTOTYPE_JSON,
	PROTOTYPE_KEY,
	PROTOTYPE_PATH,
	SANITIZED_COMMAND,
} from "./support/dispatch-details-harness.ts";

test("display JSON strips terminal sequences recursively", () => {
	assert.deepEqual(sanitizeDisplayJson({ command: CONTROLLED_COMMAND }), {
		command: SANITIZED_COMMAND,
	});
});

test("display JSON strips private-mode, reset, C0, C1, and control-string sequences", () => {
	assert.deepEqual(sanitizeDisplayJson({ command: EXTENDED_CONTROLLED_TEXT }), {
		command: EXTENDED_SANITIZED_TEXT,
	});

	const details = createDeltaDetails(DESCRIPTION, {
		id: 1,
		name: "bash",
		args: { command: EXTENDED_CONTROLLED_TEXT },
		status: "err",
		preview: EXTENDED_CONTROLLED_TEXT,
		result: {
			content: [{ type: "text", text: EXTENDED_CONTROLLED_TEXT }],
			isError: true,
		},
	});
	const serialized = JSON.stringify(details);

	assert.equal(serialized.includes("\\u001b"), false);
	assert.equal(serialized.includes("\\u0007"), false);
	assert.equal(serialized.includes("\\u009b"), false);
	assert.equal(details.dispatches[0]?.preview, EXTENDED_SANITIZED_TEXT);
	assert.equal(details.dispatches[0]?.result?.content[0]?.text, EXTENDED_SANITIZED_TEXT);
});

test("display JSON preserves an own __proto__ key without changing the prototype", () => {
	const sanitized = sanitizeDisplayJson(JSON.parse(PROTOTYPE_JSON));
	const record = sanitized as { [key: string]: unknown };

	assert.equal(Object.getPrototypeOf(sanitized), Object.prototype);
	assert.equal(Object.hasOwn(record, PROTOTYPE_KEY), true);
	assert.deepEqual(record[PROTOTYPE_KEY], { path: PROTOTYPE_PATH });
	assert.equal(record.path, undefined);
});
