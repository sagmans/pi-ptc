import { strict as assert } from "node:assert";
import test from "node:test";
import type { DispatchKind } from "../src/scheduler.ts";
import type { ToolCatalogEntry } from "../src/tool-catalog.ts";
import {
	classifyToolDispatch,
	createToolExecutor,
	NESTED_PTC_TOOL_CALL_ID_PREFIX,
} from "../src/tool-executor.ts";
import {
	createEntry,
	createSession,
	OTHER_TOOL_NAME,
	resultText,
	TOOL_NAME,
} from "./support/tool-executor-harness.ts";

test("nested call IDs are unique and use the named prefix", async () => {
	const executor = createToolExecutor({ catalog: [createEntry()], session: createSession() });
	const [first, second] = await Promise.all([
		executor.dispatch({ name: TOOL_NAME, args: {} }),
		executor.dispatch({ name: TOOL_NAME, args: {} }),
	]);
	assert.notEqual(first.toolCallId, second.toolCallId);
	assert.match(first.toolCallId, new RegExp(`^${NESTED_PTC_TOOL_CALL_ID_PREFIX}`));
	assert.match(second.toolCallId, new RegExp(`^${NESTED_PTC_TOOL_CALL_ID_PREFIX}`));
});

test("activation callback receives only additions retained by finalization", async () => {
	const retainedNames = ["alpha", "beta"];
	const activated: Array<readonly string[]> = [];
	const entries = [
		createEntry({
			name: "retained",
			execute: async () => ({ content: [], details: {}, addedToolNames: retainedNames }),
		}),
		createEntry({
			name: "empty",
			execute: async () => ({ content: [], details: {}, addedToolNames: [] }),
		}),
		createEntry({
			name: "discarded",
			execute: async () => ({ content: [], details: {}, addedToolNames: ["discarded"] }),
		}),
	];
	const executor = createToolExecutor({
		catalog: entries,
		session: createSession({
			afterToolCall(context) {
				if (context.toolCall.name === "discarded") throw new Error("postprocessor failed");
			},
		}),
		activateTools: (names) => void activated.push(names),
	});

	await executor.dispatch({ name: "retained", args: {} });
	await executor.dispatch({ name: "empty", args: {} });
	await executor.dispatch({ name: "discarded", args: {} });
	assert.equal(activated.length, 1);
	assert.equal(activated[0], retainedNames);
});

test("executor indexes a fixed catalog snapshot", async () => {
	const catalog = [createEntry()];
	const executor = createToolExecutor({ catalog, session: createSession() });
	catalog.push(createEntry({ name: OTHER_TOOL_NAME }));

	const absent = await executor.dispatch({ name: OTHER_TOOL_NAME, args: {} });
	assert.equal(absent.isError, true);
	assert.equal(resultText(absent.result), `Tool ${OTHER_TOOL_NAME} not found`);
	const nextExecutor = createToolExecutor({ catalog, session: createSession() });
	const present = await nextExecutor.dispatch({ name: OTHER_TOOL_NAME, args: {} });
	assert.equal(present.isError, false);
});

test("dispatch classification honors execution mode before known-core fallback", () => {
	const cases: Array<{ entry: ToolCatalogEntry; expected: DispatchKind }> = [
		{ entry: createEntry({ name: "foreign", executionMode: "sequential" }), expected: "exclusive" },
		{ entry: createEntry({ name: "bash", executionMode: "parallel" }), expected: "parallel" },
		{ entry: createEntry({ name: "bash" }), expected: "exclusive" },
		{ entry: createEntry({ name: "edit" }), expected: "exclusive" },
		{ entry: createEntry({ name: "write" }), expected: "exclusive" },
		{ entry: createEntry({ name: "read" }), expected: "parallel" },
		{ entry: createEntry({ name: "foreign" }), expected: "parallel" },
	];
	for (const { entry, expected } of cases) {
		assert.equal(classifyToolDispatch(entry), expected, entry.name);
	}
});
