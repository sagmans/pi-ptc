import { strict as assert } from "node:assert";
import test from "node:test";

import { ToolCallError, toCanonicalValue } from "../src/canonical.ts";

test("read success is text plus details", () => {
	assert.deepEqual(
		toCanonicalValue("read", {
			content: [{ type: "text", text: "hello" }],
			details: { truncation: { truncated: true } },
		}),
		{ text: "hello", truncation: { truncated: true } },
	);
});

test("bash success is output plus exitCode and details", () => {
	assert.deepEqual(
		toCanonicalValue("bash", {
			content: [{ type: "text", text: "ok" }],
			details: { fullOutputPath: "/tmp/out" },
		}),
		{ output: "ok", exitCode: 0, fullOutputPath: "/tmp/out" },
	);
});

test("edit and write success are ok plus details", () => {
	assert.deepEqual(
		toCanonicalValue("edit", {
			content: [{ type: "text", text: "changed" }],
			details: { diff: "-a\n+b" },
		}),
		{ ok: true, diff: "-a\n+b" },
	);
	assert.deepEqual(
		toCanonicalValue("write", {
			content: [{ type: "text", text: "wrote" }],
		}),
		{ ok: true },
	);
});

test("grep find and ls success are text plus details", () => {
	assert.deepEqual(
		toCanonicalValue("grep", {
			content: [{ type: "text", text: "src/a.ts:1:hit" }],
			details: { matchLimitReached: 20 },
		}),
		{ text: "src/a.ts:1:hit", matchLimitReached: 20 },
	);
	assert.deepEqual(
		toCanonicalValue("find", {
			content: [{ type: "text", text: "src/a.ts" }],
			details: { resultLimitReached: 5 },
		}),
		{ text: "src/a.ts", resultLimitReached: 5 },
	);
	assert.deepEqual(
		toCanonicalValue("ls", {
			content: [{ type: "text", text: "src" }],
			details: { entryLimitReached: 3 },
		}),
		{ text: "src", entryLimitReached: 3 },
	);
});

test("failed factory result rejects as ToolCallError", () => {
	assert.throws(
		() =>
			toCanonicalValue("read", {
				content: [{ type: "text", text: "missing" }],
				isError: true,
			}),
		(error: unknown) => {
			assert.ok(error instanceof ToolCallError);
			assert.equal(error.toolName, "read");
			assert.equal(error.message, "missing");
			return true;
		},
	);
});
