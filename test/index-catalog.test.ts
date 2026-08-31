import { strict as assert } from "node:assert";
import test from "node:test";

import { TRANSPORT_NAME } from "../src/config.ts";
import { createFakePi, installHarness, startAndCapture } from "./support/index-harness.ts";

test("post-bind capture applies after pending session_start without premature inert state", () => {
	const harness = createFakePi([
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
	installHarness(harness);
	const writesBefore = harness.physicalWriteCount();

	harness.handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		harness.ctx,
	);

	assert.deepEqual(harness.physicalActive(), [
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
	assert.equal(harness.physicalWriteCount(), writesBefore);
	assert.deepEqual(harness.notifications, []);
	assert.deepEqual(harness.statuses, []);

	harness.captureRuntime();

	assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);
	assert.deepEqual(harness.pi.getActiveTools(), [
		"read",
		"bash",
		"edit",
		"write",
		"grep",
		"find",
		"ls",
		"mcp",
		"mcpScript",
		TRANSPORT_NAME,
	]);
	assert.deepEqual(harness.notifications, []);
	assert.deepEqual(harness.statuses, ["ptc: code"]);
});

test("session_start preserves an intentionally empty logical active set", () => {
	const harness = createFakePi([], ["read", "bash", "mcp"]);
	installHarness(harness);
	startAndCapture(harness);
	assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);
	assert.deepEqual(harness.pi.getActiveTools(), [TRANSPORT_NAME]);
});

test("another extension read-modify-write keeps hidden logical tools under code", () => {
	const harness = createFakePi(["read", "bash", "mcp"], ["read", "bash", "mcp", "web_search"]);
	installHarness(harness);
	startAndCapture(harness);

	const active = harness.pi.getActiveTools();
	harness.pi.setActiveTools([...active.filter((name) => name !== "bash"), "web_search"]);

	assert.deepEqual(harness.pi.getActiveTools(), ["read", "mcp", "web_search", TRANSPORT_NAME]);
	assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);
	harness.handlers.get("turn_start")?.({}, harness.ctx);
	assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);
});

test("tools registered during session_start enter the first post-bind capture", () => {
	const harness = createFakePi(["read"]);
	installHarness(harness);
	harness.handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		harness.ctx,
	);
	harness.registerRuntimeTool("session_tool");
	harness.captureRuntime();

	assert.deepEqual(harness.pi.getActiveTools(), ["read", "session_tool", TRANSPORT_NAME]);
	assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);
});

test("tools registered from command handlers refresh logical state without native exposure", () => {
	const harness = createFakePi(["read", "mcp"]);
	installHarness(harness);
	startAndCapture(harness);

	harness.registerRuntimeTool("command_tool");

	assert.deepEqual(harness.pi.getActiveTools(), ["read", "mcp", "command_tool", TRANSPORT_NAME]);
	assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);
});

test("session catalogs do not leak logical state or teardown across installers", () => {
	const first = createFakePi(["read"], ["read", "first_only"]);
	const second = createFakePi(["bash"], ["bash", "second_only"]);
	installHarness(first);
	installHarness(second);
	startAndCapture(first);
	startAndCapture(second);

	first.pi.setActiveTools(["read", "first_only", TRANSPORT_NAME]);
	assert.deepEqual(first.pi.getActiveTools(), ["read", "first_only", TRANSPORT_NAME]);
	assert.deepEqual(second.pi.getActiveTools(), ["bash", TRANSPORT_NAME]);
	first.handlers.get("session_shutdown")?.({}, first.ctx);
	assert.deepEqual(first.physicalActive(), ["read", "first_only"]);
	assert.deepEqual(second.physicalActive(), [TRANSPORT_NAME]);
	assert.deepEqual(second.pi.getActiveTools(), ["bash", TRANSPORT_NAME]);
});
