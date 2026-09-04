import { strict as assert } from "node:assert";
import test from "node:test";

import { hasCompetingOwner, resolveActiveTools } from "../src/presentation.ts";

const LOGICAL = ["read", "bash", "edit", "write", "grep", "find", "ls", "mcp", "mcpScript"];

test("code-only resolution exposes exactly ptc", () => {
	assert.deepEqual(resolveActiveTools({ logical: LOGICAL, registered: [...LOGICAL, "ptc"] }), {
		tools: ["ptc"],
		missingTransport: false,
	});
});

test("resolution always strips ptc from logical input", () => {
	assert.deepEqual(
		resolveActiveTools({ logical: ["read", "ptc", "mcp"], registered: ["read", "mcp", "ptc"] }),
		{ tools: ["ptc"], missingTransport: false },
	);
});

test("competing owners are detected by reserved transport names", () => {
	assert.equal(hasCompetingOwner(["read", "fabric_exec"]), true);
	assert.equal(hasCompetingOwner(["read", "mcp"]), false);
});

test("missing ptc transport fail-closes to logical tools", () => {
	assert.deepEqual(
		resolveActiveTools({
			logical: LOGICAL,
			registered: ["read", "bash", "mcp"],
		}),
		{
			tools: LOGICAL,
			missingTransport: true,
		},
	);
});
