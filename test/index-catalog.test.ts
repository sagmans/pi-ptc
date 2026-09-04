import { strict as assert } from "node:assert";
import test from "node:test";

import { Type } from "typebox";

import { TRANSPORT_NAME } from "../src/config.ts";
import type { PiRuntimeTool } from "../src/pi-runtime.ts";
import {
	createFakePi,
	createRealAdapterHarness,
	type FakePiHarness,
	installHarness,
	parseOuterResult,
	type RealAdapterHarness,
	startAndCapture,
} from "./support/index-harness.ts";

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

test("each production execution keeps one catalog snapshot until the next run", async () => {
	let harness: FakePiHarness;
	const lateExecutable: PiRuntimeTool = {
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "late" }] };
		},
	};
	const mutatorExecutable: PiRuntimeTool = {
		parameters: Type.Object({}),
		async execute() {
			harness.registerRuntimeTool("late", lateExecutable, { name: "late" });
			harness.pi.setActiveTools(["mutator", "late"]);
			assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);
			return { content: [{ type: "text", text: "mutated" }] };
		},
	};
	harness = createFakePi(["mutator", "old"]);
	harness.registerRuntimeTool("mutator", mutatorExecutable, { name: "mutator" });
	harness.registerRuntimeTool("old", {
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "old" }] };
		},
	});
	installHarness(harness);
	startAndCapture(harness);
	const tool = harness.tools.get(TRANSPORT_NAME);
	assert.ok(tool);

	const first = parseOuterResult(
		await tool.execute(
			"snapshot-first",
			{
				code: "await tools.mutator({}); return { late: typeof tools.late, old: typeof tools.old };",
				description: "mutate catalog during run",
			},
			undefined,
			undefined,
			harness.ctx,
		),
	).result;
	assert.deepEqual(first, { late: "undefined", old: "function" });
	const second = parseOuterResult(
		await tool.execute(
			"snapshot-second",
			{
				code: "return { late: typeof tools.late, old: typeof tools.old };",
				description: "read next catalog snapshot",
			},
			undefined,
			undefined,
			harness.ctx,
		),
	).result;
	assert.deepEqual(second, { late: "function", old: "undefined" });
});

test("production keeps pre-refresh real-adapter bindings fixed until the next run", async () => {
	let harness: RealAdapterHarness;
	let oldExecutions = 0;
	const oldExecutable: PiRuntimeTool = {
		parameters: Type.Object({}),
		async execute() {
			oldExecutions += 1;
			return { content: [{ type: "text", text: "old-v1" }] };
		},
	};
	const lateExecutable: PiRuntimeTool = {
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "late-v1" }] };
		},
	};
	const mutatorExecutable: PiRuntimeTool = {
		parameters: Type.Object({}),
		async execute() {
			harness.registerRuntimeTool("late", lateExecutable);
			harness.setActiveTools(["mutator", "late", TRANSPORT_NAME]);
			return { content: [{ type: "text", text: "mutated" }] };
		},
	};
	harness = createRealAdapterHarness(
		["mutator", "old"],
		[
			["mutator", mutatorExecutable, { name: "mutator" }],
			["old", oldExecutable, { name: "old" }],
		],
	);

	try {
		await harness.start();
		const tool = harness.tools.get(TRANSPORT_NAME);
		assert.ok(tool);
		const first = parseOuterResult(
			await tool.execute(
				"real-refresh-first",
				{
					code: "await tools.mutator({}); const old = await tools.old({}); return { late: typeof tools.late, old: old.text };",
					description: "refresh real adapter during run",
				},
				undefined,
				undefined,
				harness.ctx,
			),
		).result;
		assert.deepEqual(first, { late: "undefined", old: "old-v1" });
		assert.equal(oldExecutions, 1);
		assert.deepEqual(harness.notifications, []);
		assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);

		const second = parseOuterResult(
			await tool.execute(
				"real-refresh-second",
				{
					code: "return { late: typeof tools.late, old: typeof tools.old };",
					description: "read refreshed real adapter catalog",
				},
				undefined,
				undefined,
				harness.ctx,
			),
		).result;
		assert.deepEqual(second, { late: "function", old: "undefined" });
	} finally {
		harness.shutdown();
	}
});

test("addedToolNames updates logical state without exposing physical tools under code", async () => {
	const harness = createFakePi(["activator"], ["activator", "dormant"]);
	harness.registerRuntimeTool("activator", {
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: "activated" }],
				addedToolNames: ["dormant", "dormant", "missing", TRANSPORT_NAME],
			};
		},
	});
	installHarness(harness);
	startAndCapture(harness);
	const tool = harness.tools.get(TRANSPORT_NAME);
	assert.ok(tool);

	await tool.execute(
		"activate-added",
		{ code: "return await tools.activator({});", description: "activate added tools" },
		undefined,
		undefined,
		harness.ctx,
	);

	assert.deepEqual(harness.pi.getActiveTools(), ["activator", "dormant", TRANSPORT_NAME]);
	assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);
});

test("activation publication failure terminalizes once and makes future runs inert", async () => {
	const activationMessage = "activation publication failed";
	let codePresentationWrites = 0;
	const harness = createFakePi(["activator"], ["activator", "dormant"], {
		setActiveToolsError(names) {
			if (names.length !== 1 || names[0] !== TRANSPORT_NAME) return undefined;
			codePresentationWrites += 1;
			return codePresentationWrites === 2 ? new Error(activationMessage) : undefined;
		},
	});
	harness.registerRuntimeTool("activator", {
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: "executed" }],
				addedToolNames: ["dormant"],
			};
		},
	});
	installHarness(harness);
	startAndCapture(harness);
	const tool = harness.tools.get(TRANSPORT_NAME);
	assert.ok(tool);
	const updates: unknown[] = [];

	const first = parseOuterResult(
		await tool.execute(
			"activation-failure",
			{
				code: "try { await tools.activator({}); } catch (error) { return String(error); }",
				description: "fail activation publication",
			},
			undefined,
			(partial) => updates.push(partial),
			harness.ctx,
		),
	);
	assert.match(String(first.result), new RegExp(activationMessage));
	assert.equal(updates.length, 2);
	assert.deepEqual(harness.physicalActive(), ["activator"]);
	assert.equal(harness.statuses.at(-1), "ptc: inert");
	await assert.rejects(
		() =>
			tool.execute(
				"activation-after-inert",
				{ code: "return true;", description: "reject stale execution" },
				undefined,
				undefined,
				harness.ctx,
			),
		/capture|unavailable/,
	);
});
