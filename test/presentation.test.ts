import { strict as assert } from "node:assert";
import test from "node:test";

import { applyPresentation, hasCompetingOwner, resolveActiveTools } from "../src/presentation.ts";

const LOGICAL = ["read", "bash", "edit", "write", "grep", "find", "ls", "mcp", "mcpScript"];

test("code presentation exposes exactly ptc", () => {
	assert.deepEqual(applyPresentation({ presentation: "code", logical: LOGICAL }), ["ptc"]);
});

test("both presentation preserves logical order and adds ptc", () => {
	assert.deepEqual(applyPresentation({ presentation: "both", logical: LOGICAL }), [
		...LOGICAL,
		"ptc",
	]);
});

test("native presentation preserves logical tools without ptc", () => {
	assert.deepEqual(applyPresentation({ presentation: "native", logical: LOGICAL }), LOGICAL);
});

test("presentation always strips ptc from logical input", () => {
	assert.deepEqual(applyPresentation({ presentation: "both", logical: ["read", "ptc", "mcp"] }), [
		"read",
		"mcp",
		"ptc",
	]);
});

test("competing owners are detected by reserved transport names", () => {
	assert.equal(hasCompetingOwner(["read", "fabric_exec"]), true);
	assert.equal(hasCompetingOwner(["read", "mcp"]), false);
});

test("missing ptc transport fail-closes to native logical tools", () => {
	assert.deepEqual(
		resolveActiveTools({
			presentation: "code",
			logical: LOGICAL,
			registered: ["read", "bash", "mcp"],
		}),
		{
			tools: LOGICAL,
			missingTransport: true,
		},
	);
});
