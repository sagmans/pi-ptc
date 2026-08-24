import { strict as assert } from "node:assert";
import test from "node:test";

import { applyPresentation, hasCompetingOwner, resolveActiveTools } from "../src/presentation.ts";

const RECORDED = ["read", "bash", "edit", "write", "grep", "find", "ls", "mcp", "mcpScript"];

test("code presentation hides core tools and keeps foreign tools", () => {
	assert.deepEqual(applyPresentation({ presentation: "code", recorded: RECORDED }), [
		"mcp",
		"mcpScript",
		"ptc",
	]);
});

test("both presentation keeps core tools and adds ptc", () => {
	assert.deepEqual(applyPresentation({ presentation: "both", recorded: RECORDED }), [
		"read",
		"bash",
		"edit",
		"write",
		"grep",
		"find",
		"ls",
		"mcp",
		"mcpScript",
		"ptc",
	]);
});

test("native presentation restores recorded core tools without ptc", () => {
	assert.deepEqual(applyPresentation({ presentation: "native", recorded: RECORDED }), [
		"read",
		"bash",
		"edit",
		"write",
		"grep",
		"find",
		"ls",
		"mcp",
		"mcpScript",
	]);
});

test("code presentation does not revive a core tool the session never had", () => {
	assert.deepEqual(applyPresentation({ presentation: "code", recorded: ["read", "mcp"] }), [
		"mcp",
		"ptc",
	]);
});

test("competing owners are detected by reserved transport names", () => {
	assert.equal(hasCompetingOwner(["read", "fabric_exec"]), true);
	assert.equal(hasCompetingOwner(["read", "mcp"]), false);
});

test("missing ptc transport fail-closes to native core tools", () => {
	assert.deepEqual(
		resolveActiveTools({
			presentation: "code",
			recorded: RECORDED,
			registered: ["read", "bash", "mcp"],
		}),
		{
			tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "mcp", "mcpScript"],
			missingTransport: true,
		},
	);
});
