import { strict as assert } from "node:assert";
import test from "node:test";

import { LEAK_BLOCK_REASON, loadPresentation, TRANSPORT_NAME } from "../src/config.ts";
import installPtc from "../src/index.ts";
import {
	COMPETING_TOOL_NAME,
	createFakePi,
	type FakePiHarness,
	INERT_RUNTIME_DIAGNOSTIC,
	installHarness,
	startAndCapture,
	tempPaths,
} from "./support/index-harness.ts";

test("competing owner is inert and restores native logical tools when detected later", async () => {
	const initial = createFakePi(["read", "bash", COMPETING_TOOL_NAME]);
	installHarness(initial);
	startAndCapture(initial);
	assert.deepEqual(initial.physicalActive(), ["read", "bash", COMPETING_TOOL_NAME]);
	assert.match(initial.notifications[0] ?? "", /inert/);

	const readinessCases: Array<{
		name: string;
		invoke(harness: FakePiHarness): unknown;
	}> = [
		{
			name: "turn_start",
			invoke: (harness) => harness.handlers.get("turn_start")?.({}, harness.ctx),
		},
		{
			name: "/ptc",
			invoke: (harness) => harness.commands.get("ptc")?.handler("off", harness.ctx),
		},
		{
			name: "tool_call",
			invoke: (harness) => harness.emitToolCall({ toolName: "read" }),
		},
		{
			name: "before_agent_start",
			invoke: (harness) => harness.emitBeforeAgentStart("prompt"),
		},
	];

	for (const readinessCase of readinessCases) {
		const later = createFakePi(["read", "bash"]);
		installHarness(later);
		startAndCapture(later);
		later.registerRuntimeTool(COMPETING_TOOL_NAME);
		assert.deepEqual(later.physicalActive(), [TRANSPORT_NAME], readinessCase.name);

		assert.equal(await readinessCase.invoke(later), undefined, readinessCase.name);
		assert.deepEqual(
			later.physicalActive(),
			["read", "bash", COMPETING_TOOL_NAME],
			readinessCase.name,
		);
		assert.equal(later.notifications.length, 1, readinessCase.name);
		assert.match(later.notifications[0] ?? "", /competing|inert/i, readinessCase.name);
		assert.equal(
			later.statuses.filter((status) => status === "ptc: inert").length,
			1,
			readinessCase.name,
		);
	}
});

test("post-aggregation finalizers detect owners registered after PTC marker handlers", async () => {
	const toolCallHarness = createFakePi(["read", "bash"]);
	installHarness(toolCallHarness);
	startAndCapture(toolCallHarness);

	const toolCallResult = await toolCallHarness.emitToolCall({ toolName: "read" }, () => {
		toolCallHarness.registerRuntimeTool(COMPETING_TOOL_NAME);
	});

	assert.equal(toolCallResult, undefined);
	assert.deepEqual(toolCallHarness.physicalActive(), ["read", "bash", COMPETING_TOOL_NAME]);
	assert.equal(toolCallHarness.notifications.length, 1);

	const beforeStartHarness = createFakePi(["read", "bash"]);
	installHarness(beforeStartHarness);
	startAndCapture(beforeStartHarness);

	const beforeStartResult = await beforeStartHarness.emitBeforeAgentStart(
		"prompt",
		{ skills: [] },
		() => {
			beforeStartHarness.registerRuntimeTool(COMPETING_TOOL_NAME);
		},
	);

	assert.equal(beforeStartResult, undefined);
	assert.deepEqual(beforeStartHarness.physicalActive(), ["read", "bash", COMPETING_TOOL_NAME]);
	assert.equal(beforeStartHarness.notifications.length, 1);
});

test("compatibility mismatch stays inert, preserves actions, and reports once with context", () => {
	const harness = createFakePi(["read", "bash"]);
	installPtc(harness.pi, {
		resolvePaths: tempPaths,
		installRuntimeCapture() {
			return { compatible: false, diagnostic: INERT_RUNTIME_DIAGNOSTIC };
		},
	});
	const writesBefore = harness.physicalWriteCount();

	harness.handlers.get("session_start")?.({}, harness.ctx);
	harness.handlers.get("turn_start")?.({}, harness.ctx);

	assert.deepEqual(harness.physicalActive(), ["read", "bash"]);
	assert.equal(harness.physicalWriteCount(), writesBefore);
	assert.equal(harness.tools.has(TRANSPORT_NAME), false);
	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0] ?? "", /Unsupported Pi runtime version/);
	assert.equal(harness.statuses.at(-1), "ptc: inert");
});

test("same-name untagged ptc shadow becomes inert at first post-bind readiness event", async () => {
	const harness = createFakePi(["read", TRANSPORT_NAME], ["read", TRANSPORT_NAME], {
		shadowTransport: true,
	});
	installHarness(harness);
	const writesBefore = harness.physicalWriteCount();

	harness.handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		harness.ctx,
	);
	assert.equal(harness.tools.has(TRANSPORT_NAME), false);
	assert.deepEqual(harness.physicalActive(), ["read", TRANSPORT_NAME]);
	assert.deepEqual(harness.pi.getActiveTools(), ["read", TRANSPORT_NAME]);
	assert.equal(harness.physicalWriteCount(), writesBefore);
	assert.deepEqual(harness.notifications, []);
	assert.deepEqual(harness.statuses, []);

	assert.equal(harness.handlers.get("tool_call")?.({ toolName: "read" }, harness.ctx), undefined);
	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0] ?? "", /inert|capture/i);
	assert.deepEqual(harness.statuses, ["ptc: inert"]);

	assert.equal(
		harness.handlers.get("before_agent_start")?.({ systemPrompt: "native" }, harness.ctx),
		undefined,
	);
	await harness.commands.get("ptc")?.handler("off", harness.ctx);
	harness.handlers.get("turn_start")?.({}, harness.ctx);
	assert.deepEqual(harness.physicalActive(), ["read", TRANSPORT_NAME]);
	assert.equal(harness.physicalWriteCount(), writesBefore);
	assert.equal(harness.notifications.length, 1);
	assert.deepEqual(harness.statuses, ["ptc: inert"]);
});

test("every post-bind readiness entry point resolves pending capture without blocking or injection", async () => {
	const readinessCases: Array<{
		name: string;
		invoke(harness: FakePiHarness): unknown;
	}> = [
		{
			name: "turn_start",
			invoke: (harness) => harness.handlers.get("turn_start")?.({}, harness.ctx),
		},
		{
			name: "/ptc",
			invoke: (harness) => harness.commands.get("ptc")?.handler("off", harness.ctx),
		},
		{
			name: "tool_call",
			invoke: (harness) => harness.handlers.get("tool_call")?.({ toolName: "read" }, harness.ctx),
		},
		{
			name: "before_agent_start",
			invoke: (harness) =>
				harness.handlers.get("before_agent_start")?.({ systemPrompt: "native" }, harness.ctx),
		},
	];

	for (const readinessCase of readinessCases) {
		const harness = createFakePi(["read", TRANSPORT_NAME], ["read", TRANSPORT_NAME], {
			shadowTransport: true,
		});
		installHarness(harness);
		const writesBefore = harness.physicalWriteCount();
		harness.handlers.get("session_start")?.(
			{ type: "session_start", reason: "startup" },
			harness.ctx,
		);
		assert.deepEqual(harness.notifications, [], readinessCase.name);
		assert.deepEqual(harness.statuses, [], readinessCase.name);

		assert.equal(await readinessCase.invoke(harness), undefined, readinessCase.name);
		assert.deepEqual(harness.physicalActive(), ["read", TRANSPORT_NAME], readinessCase.name);
		assert.equal(harness.physicalWriteCount(), writesBefore, readinessCase.name);
		assert.equal(harness.notifications.length, 1, readinessCase.name);
		assert.match(harness.notifications[0] ?? "", /inert|capture/i, readinessCase.name);
		assert.deepEqual(harness.statuses, ["ptc: inert"], readinessCase.name);
	}
});

test("captured shape mismatch remains native and reports when session context exists", () => {
	const harness = createFakePi(["read", "bash"]);
	installHarness(harness);
	const writesBefore = harness.physicalWriteCount();

	harness.captureIncompatible("Bound AgentSession._toolRegistry is unavailable");
	harness.handlers.get("session_start")?.({}, harness.ctx);

	assert.deepEqual(harness.physicalActive(), ["read", "bash"]);
	assert.equal(harness.physicalWriteCount(), writesBefore);
	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0] ?? "", /_toolRegistry/);
});

test("owned transport cleanup failure stays diagnostic and never activates catalog wiring", async () => {
	const cleanupFailure = new Error("planned active-tool cleanup failure");
	const harness = createFakePi(["read", TRANSPORT_NAME], ["read"]);
	installHarness(harness);
	harness.handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		harness.ctx,
	);
	harness.pi.setActiveTools = () => {
		throw cleanupFailure;
	};

	harness.captureIncompatible("Bound AgentSession._toolRegistry is unavailable", {
		isCurrent: () => true,
	});

	assert.deepEqual(harness.physicalActive(), ["read", TRANSPORT_NAME]);
	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0] ?? "", /cleanup failed.*planned active-tool cleanup/i);
	assert.deepEqual(harness.statuses, ["ptc: inert"]);
	const tool = harness.tools.get(TRANSPORT_NAME);
	assert.ok(tool);
	await assert.rejects(
		() =>
			tool.execute(
				"cleanup-failed-inert",
				{ code: "return null;", description: "stay inert" },
				undefined,
				undefined,
				harness.ctx,
			),
		/capture|unavailable/i,
	);
});

test("tool_call blocks every leaked active tool under code presentation", async () => {
	const harness = createFakePi(["read", "bash", "mcp"]);
	installHarness(harness);
	startAndCapture(harness);
	assert.deepEqual(await harness.emitToolCall({ toolName: "read" }), {
		block: true,
		reason: LEAK_BLOCK_REASON,
	});
	assert.deepEqual(await harness.emitToolCall({ toolName: "mcp" }), {
		block: true,
		reason: LEAK_BLOCK_REASON,
	});
});

test("post-aggregation finalizers preserve foreign blocks and aggregate messages", async () => {
	const harness = createFakePi(["read", "bash", "mcp"]);
	installHarness(harness);
	startAndCapture(harness);
	const foreignBlock = { block: true, reason: "foreign block" };

	assert.equal(await harness.emitToolCall({ toolName: "read" }, () => foreignBlock), foreignBlock);
	const foreignMessage = { customType: "foreign", content: [] };
	const beforeResult = (await harness.emitBeforeAgentStart("prompt", { skills: [] }, () => ({
		messages: [foreignMessage],
		systemPrompt: "foreign prompt",
	}))) as { messages: unknown[]; systemPrompt: string };
	assert.deepEqual(beforeResult.messages, [foreignMessage]);
	assert.match(beforeResult.systemPrompt, /^foreign prompt/);
	assert.match(beforeResult.systemPrompt, /await tools\.read\(/);
});

test("/ptc off restores native logical tools and persists", async () => {
	const paths = tempPaths();
	const harness = createFakePi(["read", "bash", "mcp"]);
	installHarness(harness, { resolvePaths: () => paths });
	startAndCapture(harness);
	await harness.commands.get("ptc")?.handler("off", harness.ctx);
	assert.deepEqual(harness.physicalActive(), ["read", "bash", "mcp"]);
	assert.deepEqual(harness.pi.getActiveTools(), ["read", "bash", "mcp"]);
	assert.equal(loadPresentation({ projectFile: paths.projectFile, fallback: "code" }), "native");
});

test("reload shutdown restores before pending session_start and fresh post-bind capture", () => {
	const harness = createFakePi(["read", "bash"]);
	installHarness(harness);
	startAndCapture(harness);
	assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);

	harness.handlers.get("session_shutdown")?.(
		{ type: "session_shutdown", reason: "reload" },
		harness.ctx,
	);
	assert.deepEqual(harness.physicalActive(), ["read", "bash"]);
	harness.handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, harness.ctx);
	assert.deepEqual(harness.physicalActive(), ["read", "bash"]);
	harness.captureRuntime();
	assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);
	assert.deepEqual(harness.notifications, []);
	assert.deepEqual(harness.statuses, ["ptc: code", "ptc: code"]);
});
