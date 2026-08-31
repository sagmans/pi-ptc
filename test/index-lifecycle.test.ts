import { strict as assert } from "node:assert";
import test from "node:test";

import { TRANSPORT_NAME } from "../src/config.ts";
import type { PtcDispatchDetails } from "../src/dispatch-details.ts";
import {
	createFakePi,
	FAILURE_DESCRIPTION,
	FAILURE_PROGRAM,
	FAILURE_TOOL_CALL_ID,
	FIRST_FAILURE_DESCRIPTION,
	FIRST_FAILURE_PROGRAM,
	FIRST_OUTER_FAILURE_MESSAGE,
	installHarness,
	MISSING_TOOL_CALL_ID,
	OUTER_FAILURE_MESSAGE,
	SECOND_FAILURE_DESCRIPTION,
	SECOND_FAILURE_PROGRAM,
	SECOND_OUTER_FAILURE_MESSAGE,
	SHARED_TOOL_CALL_ID,
	SHUTDOWN_TOOL_CALL_ID,
	startAndCapture,
} from "./support/index-harness.ts";

test("failed ptc details are patched once by call id and cleared on shutdown", async () => {
	const harness = createFakePi(["read", "bash", "ls"]);
	installHarness(harness);
	startAndCapture(harness);
	const tool = harness.tools.get(TRANSPORT_NAME);
	assert.ok(tool);

	const executeFailure = (toolCallId: string) =>
		assert.rejects(
			tool.execute(
				toolCallId,
				{ code: FAILURE_PROGRAM, description: FAILURE_DESCRIPTION },
				undefined,
				undefined,
				harness.ctx,
			),
			new RegExp(OUTER_FAILURE_MESSAGE),
		);
	await executeFailure(FAILURE_TOOL_CALL_ID);

	const toolResult = harness.handlers.get("tool_result");
	assert.ok(toolResult);
	assert.equal(
		toolResult({ toolName: TRANSPORT_NAME, toolCallId: MISSING_TOOL_CALL_ID }, harness.ctx),
		undefined,
	);
	const patch = toolResult(
		{ toolName: TRANSPORT_NAME, toolCallId: FAILURE_TOOL_CALL_ID },
		harness.ctx,
	) as { details: PtcDispatchDetails };
	assert.equal(Object.hasOwn(patch, "content"), false);
	assert.equal(patch.details.schemaVersion, 2);
	assert.equal(patch.details.mode, "snapshot");
	assert.equal(patch.details.dispatches.length, 1);
	assert.equal(patch.details.dispatches[0]?.status, "ok");
	assert.match(patch.details.executionError ?? "", new RegExp(OUTER_FAILURE_MESSAGE));
	assert.equal(JSON.stringify(patch.details).includes(FAILURE_PROGRAM), false);
	assert.equal(
		toolResult({ toolName: TRANSPORT_NAME, toolCallId: FAILURE_TOOL_CALL_ID }, harness.ctx),
		undefined,
	);

	await executeFailure(SHUTDOWN_TOOL_CALL_ID);
	harness.handlers.get("session_shutdown")?.({}, harness.ctx);
	assert.equal(
		toolResult({ toolName: TRANSPORT_NAME, toolCallId: SHUTDOWN_TOOL_CALL_ID }, harness.ctx),
		undefined,
	);
});

test("failure handoff is isolated between installers with the same call id", async () => {
	const first = createFakePi(["read", "bash", "ls"]);
	const second = createFakePi(["read", "bash", "ls"]);
	installHarness(first);
	installHarness(second);
	startAndCapture(first);
	startAndCapture(second);
	const firstTool = first.tools.get(TRANSPORT_NAME);
	const secondTool = second.tools.get(TRANSPORT_NAME);
	const firstToolResult = first.handlers.get("tool_result");
	const secondToolResult = second.handlers.get("tool_result");
	assert.ok(firstTool);
	assert.ok(secondTool);
	assert.ok(firstToolResult);
	assert.ok(secondToolResult);

	await assert.rejects(
		firstTool.execute(
			SHARED_TOOL_CALL_ID,
			{ code: FIRST_FAILURE_PROGRAM, description: FIRST_FAILURE_DESCRIPTION },
			undefined,
			undefined,
			first.ctx,
		),
		new RegExp(FIRST_OUTER_FAILURE_MESSAGE),
	);
	await assert.rejects(
		secondTool.execute(
			SHARED_TOOL_CALL_ID,
			{ code: SECOND_FAILURE_PROGRAM, description: SECOND_FAILURE_DESCRIPTION },
			undefined,
			undefined,
			second.ctx,
		),
		new RegExp(SECOND_OUTER_FAILURE_MESSAGE),
	);

	const firstPatch = firstToolResult(
		{ toolName: TRANSPORT_NAME, toolCallId: SHARED_TOOL_CALL_ID },
		first.ctx,
	) as { details: PtcDispatchDetails };
	assert.match(firstPatch.details.executionError ?? "", new RegExp(FIRST_OUTER_FAILURE_MESSAGE));
	assert.equal(
		firstToolResult({ toolName: TRANSPORT_NAME, toolCallId: SHARED_TOOL_CALL_ID }, first.ctx),
		undefined,
	);
	const secondPatch = secondToolResult(
		{ toolName: TRANSPORT_NAME, toolCallId: SHARED_TOOL_CALL_ID },
		second.ctx,
	) as { details: PtcDispatchDetails };
	assert.match(secondPatch.details.executionError ?? "", new RegExp(SECOND_OUTER_FAILURE_MESSAGE));
	assert.equal(
		secondToolResult({ toolName: TRANSPORT_NAME, toolCallId: SHARED_TOOL_CALL_ID }, second.ctx),
		undefined,
	);

	await assert.rejects(
		firstTool.execute(
			SHARED_TOOL_CALL_ID,
			{ code: FIRST_FAILURE_PROGRAM, description: FIRST_FAILURE_DESCRIPTION },
			undefined,
			undefined,
			first.ctx,
		),
		new RegExp(FIRST_OUTER_FAILURE_MESSAGE),
	);
	await assert.rejects(
		secondTool.execute(
			SHARED_TOOL_CALL_ID,
			{ code: SECOND_FAILURE_PROGRAM, description: SECOND_FAILURE_DESCRIPTION },
			undefined,
			undefined,
			second.ctx,
		),
		new RegExp(SECOND_OUTER_FAILURE_MESSAGE),
	);
	first.handlers.get("session_shutdown")?.({}, first.ctx);
	assert.equal(
		firstToolResult({ toolName: TRANSPORT_NAME, toolCallId: SHARED_TOOL_CALL_ID }, first.ctx),
		undefined,
	);
	const survivingPatch = secondToolResult(
		{ toolName: TRANSPORT_NAME, toolCallId: SHARED_TOOL_CALL_ID },
		second.ctx,
	) as { details: PtcDispatchDetails };
	assert.match(
		survivingPatch.details.executionError ?? "",
		new RegExp(SECOND_OUTER_FAILURE_MESSAGE),
	);
});

test("before_agent_start injects sdk and restores skills when read is hidden", async () => {
	const harness = createFakePi(["read", "bash", "mcp"]);
	installHarness(harness);
	startAndCapture(harness);
	const result = (await harness.emitBeforeAgentStart("prompt", {
		skills: [
			{
				name: "demo",
				description: "demo skill",
				filePath: "/tmp/demo/SKILL.md",
				disableModelInvocation: false,
			},
		],
	})) as { systemPrompt: string };
	assert.match(result.systemPrompt, /await tools\.read\(/);
	assert.match(result.systemPrompt, /tools\.read/);
	assert.match(result.systemPrompt, /<name>demo<\/name>/);
});
