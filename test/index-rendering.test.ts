import { strict as assert } from "node:assert";
import test from "node:test";

import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { TRANSPORT_NAME } from "../src/config.ts";
import type { PtcDispatchDetails } from "../src/dispatch-details.ts";
import type { PiRuntimeTool } from "../src/pi-runtime.ts";
import {
	createExecutable,
	createFakePi,
	createRealAdapterHarness,
	installHarness,
	parseOuterResult,
	type RealAdapterHarness,
	renderToolResult,
	startAndCapture,
	VISUAL_RUNTIME_TOOL_NAME,
} from "./support/index-harness.ts";

test("rollback setter failure retries native restoration through the host and stays inert", async () => {
	let harness: RealAdapterHarness;
	let oldExecutions = 0;
	let nativeRestoreAttempts = 0;
	const rollbackFailure = new Error("planned rollback setter failure");
	const oldExecutable: PiRuntimeTool = {
		parameters: Type.Object({}),
		async execute() {
			oldExecutions += 1;
			return { content: [{ type: "text", text: "stale" }] };
		},
	};
	const invalidExecutable = {
		execute: async () => ({ content: [{ type: "text", text: "invalid" }] }),
	} as unknown as PiRuntimeTool;
	const breakerExecutable: PiRuntimeTool = {
		parameters: Type.Object({}),
		async execute() {
			harness.registerRuntimeTool("invalid_after_refresh", invalidExecutable);
			return { content: [{ type: "text", text: "unreachable" }] };
		},
	};
	harness = createRealAdapterHarness(
		["breaker", "old"],
		[
			["breaker", breakerExecutable, { name: "breaker" }],
			["old", oldExecutable, { name: "old" }],
		],
		{
			beforeSetActiveTools(names) {
				if (names.join(",") !== "breaker,old") return;
				nativeRestoreAttempts += 1;
				if (nativeRestoreAttempts === 1) throw rollbackFailure;
			},
		},
	);

	try {
		await harness.start();
		const tool = harness.tools.get(TRANSPORT_NAME);
		assert.ok(tool);
		const result = parseOuterResult(
			await tool.execute(
				"failed-refresh",
				{
					code: 'let refresh = "returned"; try { await tools.breaker({}); } catch (error) { refresh = String(error); } let stale = "returned"; try { await tools.old({}); } catch (error) { stale = String(error); } return { refresh, stale };',
					description: "fail refresh and reject stale bindings",
				},
				undefined,
				undefined,
				harness.ctx,
			),
		).result as { refresh: string; stale: string };

		assert.match(result.refresh, /no longer associated|stale|unavailable/i);
		assert.match(result.stale, /no longer associated|stale|unavailable/i);
		assert.equal(oldExecutions, 0);
		assert.equal(nativeRestoreAttempts, 2);
		assert.deepEqual(harness.physicalActive(), ["breaker", "old"]);
		assert.equal(harness.physicalActive().includes(TRANSPORT_NAME), false);
		assert.equal(harness.physicalActive().includes("invalid_after_refresh"), false);
		assert.equal(harness.notifications.length, 1);
		assert.match(harness.notifications[0] ?? "", /no longer associated/i);
		assert.match(harness.notifications[0] ?? "", /planned rollback setter failure/i);
		assert.deepEqual(harness.notificationLevels, ["warning"]);
		assert.equal(harness.statuses.filter((status) => status === "ptc: inert").length, 1);
		await assert.rejects(
			() =>
				tool.execute(
					"failed-refresh-stale",
					{ code: "return await tools.old({});", description: "reject stale run" },
					undefined,
					undefined,
					harness.ctx,
				),
			/capture|inert|unavailable/i,
		);

		harness.handlers.get("turn_start")?.({}, harness.ctx);
		harness.handlers.get("session_start")?.(
			{ type: "session_start", reason: "resume" },
			harness.ctx,
		);
		harness.handlers.get("tool_call")?.({ toolName: "old" }, harness.ctx);
		harness.handlers.get("before_agent_start")?.({ systemPrompt: "native" }, harness.ctx);
		assert.deepEqual(harness.physicalActive(), ["breaker", "old"]);
		assert.equal(harness.notifications.length, 1);
		assert.equal(harness.statuses.filter((status) => status === "ptc: inert").length, 1);
		assert.equal(oldExecutions, 0);
	} finally {
		harness.shutdown();
	}
});

test("failed native restoration verification stays inert with explicit cleanup failure", async () => {
	let harness: RealAdapterHarness;
	let nativeRestoreAttempts = 0;
	const invalidExecutable = {
		execute: async () => ({ content: [{ type: "text", text: "invalid" }] }),
	} as unknown as PiRuntimeTool;
	const breakerExecutable: PiRuntimeTool = {
		parameters: Type.Object({}),
		async execute() {
			harness.registerRuntimeTool("invalid_after_failed_verification", invalidExecutable);
			return { content: [{ type: "text", text: "unreachable" }] };
		},
	};
	harness = createRealAdapterHarness(
		["breaker", "old"],
		[
			["breaker", breakerExecutable, { name: "breaker" }],
			["old", createExecutable("old"), { name: "old" }],
		],
		{
			beforeSetActiveTools(names) {
				if (names.join(",") !== "breaker,old") return;
				nativeRestoreAttempts += 1;
				if (nativeRestoreAttempts === 1) {
					throw new Error("planned verification rollback failure");
				}
			},
			projectActiveTools(availableNames) {
				return nativeRestoreAttempts === 2 && availableNames.join(",") === "breaker,old"
					? ["breaker"]
					: [...availableNames];
			},
		},
	);

	try {
		await harness.start();
		const tool = harness.tools.get(TRANSPORT_NAME);
		assert.ok(tool);
		await tool.execute(
			"failed-native-verification",
			{
				code: "try { await tools.breaker({}); } catch {} return null;",
				description: "fail native restoration verification",
			},
			undefined,
			undefined,
			harness.ctx,
		);

		assert.equal(nativeRestoreAttempts, 2);
		assert.deepEqual(harness.physicalActive(), ["breaker"]);
		assert.equal(harness.notifications.length, 1);
		assert.match(harness.notifications[0] ?? "", /no longer associated/i);
		assert.match(harness.notifications[0] ?? "", /planned verification rollback failure/i);
		assert.match(
			harness.notifications[0] ?? "",
			/native active-tool restoration retry failed.*verification failed/i,
		);
		assert.deepEqual(harness.notificationLevels, ["warning"]);
		assert.equal(harness.statuses.filter((status) => status === "ptc: inert").length, 1);
		await assert.rejects(
			() =>
				tool.execute(
					"failed-native-verification-stale",
					{ code: "return await tools.breaker({});", description: "reject stale catalog" },
					undefined,
					undefined,
					harness.ctx,
				),
			/capture|inert|unavailable/i,
		);
	} finally {
		harness.shutdown();
	}
});

test("shutdown, recapture, and inert transitions clear unrendered renderer snapshots", async () => {
	for (const lifecycle of ["shutdown", "recapture", "inert"] as const) {
		const marker = `${lifecycle} renderer`;
		const harness = createFakePi([VISUAL_RUNTIME_TOOL_NAME]);
		harness.registerRuntimeTool(
			VISUAL_RUNTIME_TOOL_NAME,
			{
				parameters: Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: "rendered result" }] };
				},
			},
			{
				name: VISUAL_RUNTIME_TOOL_NAME,
				renderCall: () => new Text(marker, 0, 0),
			},
		);
		installHarness(harness);
		startAndCapture(harness);
		const tool = harness.tools.get(TRANSPORT_NAME);
		assert.ok(tool);
		const execute = (toolCallId: string) =>
			tool.execute(
				toolCallId,
				{
					code: `return await tools.${VISUAL_RUNTIME_TOOL_NAME}({});`,
					description: `run ${toolCallId}`,
				},
				undefined,
				undefined,
				harness.ctx,
			);

		const renderedCallId = `renderer-before-${lifecycle}`;
		const renderedResult = await execute(renderedCallId);
		const downstreamRenderedResult = {
			...renderedResult,
			details: JSON.parse(JSON.stringify(renderedResult.details)) as PtcDispatchDetails,
		};
		assert.match(
			renderToolResult(tool, downstreamRenderedResult, renderedCallId),
			new RegExp(marker),
		);

		const unrenderedCallId = `renderer-cleared-by-${lifecycle}`;
		const unrenderedResult = await execute(unrenderedCallId);
		if (lifecycle === "shutdown") {
			harness.handlers.get("session_shutdown")?.({}, harness.ctx);
		} else if (lifecycle === "recapture") {
			harness.captureRuntime();
		} else {
			harness.captureIncompatible("Bound AgentSession._toolRegistry is unavailable");
		}
		const downstreamUnrenderedResult = {
			...unrenderedResult,
			details: JSON.parse(JSON.stringify(unrenderedResult.details)) as PtcDispatchDetails,
		};
		assert.doesNotMatch(
			renderToolResult(tool, downstreamUnrenderedResult, unrenderedCallId),
			new RegExp(marker),
		);
	}
});

test("shutdown, reload capture, and incompatibility revoke stale production execution", async () => {
	let firstExecutions = 0;
	let secondExecutions = 0;
	const firstExecutable: PiRuntimeTool = {
		parameters: Type.Object({}),
		async execute() {
			firstExecutions += 1;
			return { content: [{ type: "text", text: "first" }] };
		},
	};
	const secondExecutable: PiRuntimeTool = {
		parameters: Type.Object({}),
		async execute() {
			secondExecutions += 1;
			return { content: [{ type: "text", text: "second" }] };
		},
	};
	const harness = createFakePi(["reloadable"]);
	harness.registerRuntimeTool("reloadable", firstExecutable);
	installHarness(harness);
	startAndCapture(harness);
	const tool = harness.tools.get(TRANSPORT_NAME);
	assert.ok(tool);
	const execute = (toolCallId: string) =>
		tool.execute(
			toolCallId,
			{ code: "return await tools.reloadable({});", description: "run reloadable" },
			undefined,
			undefined,
			harness.ctx,
		);

	await execute("reload-before");
	assert.equal(firstExecutions, 1);
	harness.handlers.get("session_shutdown")?.({}, harness.ctx);
	assert.deepEqual(harness.physicalActive(), ["reloadable"]);
	await assert.rejects(() => execute("reload-stale"), /capture|inert|unavailable/i);
	assert.equal(firstExecutions, 1);

	harness.registerRuntimeTool("reloadable", secondExecutable);
	harness.handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, harness.ctx);
	harness.captureRuntime();
	await execute("reload-after");
	assert.equal(firstExecutions, 1);
	assert.equal(secondExecutions, 1);

	harness.captureIncompatible("Bound AgentSession._toolRegistry is unavailable");
	assert.deepEqual(harness.physicalActive(), ["reloadable"]);
	await assert.rejects(() => execute("reload-incompatible"), /capture|inert|unavailable/i);
	assert.equal(secondExecutions, 1);
	assert.equal(harness.notifications.filter((message) => /_toolRegistry/.test(message)).length, 1);
	assert.equal(harness.statuses.filter((status) => status === "ptc: inert").length, 1);
});
