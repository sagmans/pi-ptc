import { strict as assert } from "node:assert";
import test from "node:test";

import { formatDispatchLine } from "../src/dispatch-format.ts";

test("formatDispatchLine names the tool, status, and target", () => {
	assert.equal(
		formatDispatchLine({ name: "read", args: { path: "a.txt" }, status: "start" }),
		"read … a.txt",
	);
	assert.equal(
		formatDispatchLine({ name: "read", args: { path: "a.txt" }, status: "ok" }),
		"read ok a.txt",
	);
	assert.equal(
		formatDispatchLine({ name: "bash", args: { command: "true" }, status: "err" }),
		"bash err true",
	);
	assert.equal(formatDispatchLine({ name: "ls", args: {}, status: "start" }), "ls …");
});
