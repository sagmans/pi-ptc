import { strict as assert } from "node:assert";
import test from "node:test";

import { SHIPPED_PTC_CONFIG } from "../src/config.ts";
import { createToolExecutor } from "../src/tool-executor.ts";
import { TOOL_UPDATE_LIMIT_MESSAGE } from "../src/tool-executor-lifecycle.ts";
import {
	createEntry,
	createSession,
	type RuntimeEvent,
	resultText,
	TOOL_NAME,
} from "./support/tool-executor-harness.ts";

const EXCESS_UPDATE_COUNT = SHIPPED_PTC_CONFIG.maxToolUpdatesPerDispatch + 1;

test("one dispatch bounds update delivery and still emits one terminal event", async () => {
	const events: RuntimeEvent[] = [];
	let callerUpdates = 0;
	const entry = createEntry({
		async execute(_id, _args, _signal, onUpdate) {
			for (let index = 0; index < EXCESS_UPDATE_COUNT; index += 1) {
				onUpdate?.({ content: [{ type: "text", text: String(index) }] });
			}
			return { content: [{ type: "text", text: "executed" }] };
		},
	});
	const executor = createToolExecutor({
		catalog: [entry],
		session: createSession({ emit: (event) => void events.push(event) }),
	});

	const outcome = await executor.dispatch({
		name: TOOL_NAME,
		args: {},
		onUpdate() {
			callerUpdates += 1;
		},
	});

	assert.equal(callerUpdates, SHIPPED_PTC_CONFIG.maxToolUpdatesPerDispatch);
	assert.equal(
		events.filter((event) => event.type === "tool_execution_update").length,
		SHIPPED_PTC_CONFIG.maxToolUpdatesPerDispatch,
	);
	assert.equal(events.filter((event) => event.type === "tool_execution_end").length, 1);
	assert.equal(outcome.isError, true);
	assert.equal(resultText(outcome.result), TOOL_UPDATE_LIMIT_MESSAGE);
});
