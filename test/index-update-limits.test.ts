import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";

import { Type } from "typebox";

import { SHIPPED_PTC_CONFIG, TRANSPORT_NAME } from "../src/config.ts";
import {
	createFakePi,
	installHarness,
	parseOuterResult,
	startAndCapture,
	tempPaths,
} from "./support/index-harness.ts";

const UPDATE_OVERFLOW_TOOL_NAME = "update_overflow";
const EXCESS_UPDATE_COUNT = SHIPPED_PTC_CONFIG.maxToolUpdatesPerDispatch + 1;

test("production keeps successful effects after excess nested updates", async () => {
	let completedEffects = 0;
	let emittedUpdates = 0;
	const harness = createFakePi([UPDATE_OVERFLOW_TOOL_NAME]);
	harness.registerRuntimeTool(UPDATE_OVERFLOW_TOOL_NAME, {
		parameters: Type.Object({}),
		async execute(_toolCallId, _args, _signal, onUpdate) {
			for (let index = 0; index < EXCESS_UPDATE_COUNT; index += 1) {
				emittedUpdates += 1;
				onUpdate?.({ content: [{ type: "text", text: String(index) }] });
			}
			completedEffects += 1;
			return { content: [{ type: "text", text: "completed" }] };
		},
	});
	installHarness(harness);
	startAndCapture(harness);
	const tool = harness.tools.get(TRANSPORT_NAME);
	assert.ok(tool);

	const outer = parseOuterResult(
		await tool.execute(
			"update-overflow",
			{
				code: `return await tools.${UPDATE_OVERFLOW_TOOL_NAME}({});`,
				description: "ignore excess nested updates",
			},
			undefined,
			undefined,
			harness.ctx,
		),
	);
	assert.equal(emittedUpdates, EXCESS_UPDATE_COUNT);
	assert.equal(completedEffects, 1);
	assert.equal((outer.result as { text: string }).text, "completed");
});

test("session overlay maxDispatches limits nested dispatches", async () => {
	let nestedCalls = 0;
	const paths = tempPaths();
	mkdirSync(dirname(paths.userFile), { recursive: true });
	writeFileSync(paths.userFile, `${JSON.stringify({ maxDispatches: 1 }, null, "\t")}\n`);
	const harness = createFakePi(["probe"]);
	harness.registerRuntimeTool("probe", {
		parameters: Type.Object({}),
		async execute() {
			nestedCalls += 1;
			return { content: [{ type: "text", text: "ok" }] };
		},
	});
	installHarness(harness, { resolvePaths: () => paths });
	startAndCapture(harness);
	const tool = harness.tools.get(TRANSPORT_NAME);
	assert.ok(tool);

	await assert.rejects(
		() =>
			tool.execute(
				"overlay-dispatch-limit",
				{
					code: "await tools.probe({}); await tools.probe({}); return 1;",
					description: "hit overlay dispatch limit",
				},
				undefined,
				undefined,
				harness.ctx,
			),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /PTC_DISPATCH_LIMIT/);
			return true;
		},
	);
	assert.equal(nestedCalls, 1);
});
