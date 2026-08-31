import { strict as assert } from "node:assert";
import test from "node:test";

import type { DispatchProgress } from "../src/bridge.ts";
import { ToolCallError } from "../src/canonical.ts";
import { createScheduler } from "../src/scheduler.ts";
import type { NestedToolRuntimeResult } from "../src/tool-executor.ts";
import {
	BINDING_SIGNAL,
	catalogEntry,
	createGenericBindings,
	dispatchResult,
	GENERIC_FAILED_MESSAGE,
	GENERIC_TOOL_NAME,
	OTHER_GENERIC_TOOL_NAME,
	toolExecutor,
} from "./support/tool-bindings-harness.ts";

test("generic bindings omit incompatible optional values and raw render details from progress", async () => {
	const cyclicDetails: { self?: unknown } = {};
	cyclicDetails.self = cyclicDetails;
	const cyclicUsage: { self?: unknown } = {};
	cyclicUsage.self = cyclicUsage;
	const reported: DispatchProgress[] = [];
	const bindings = createGenericBindings(
		[catalogEntry(GENERIC_TOOL_NAME)],
		toolExecutor(async (request) =>
			dispatchResult(request, {
				content: [{ type: "text", text: "safe" }],
				details: cyclicDetails,
				usage: cyclicUsage,
			}),
		),
		createScheduler(2),
		{ reportDispatch: (progress) => reported.push(progress) },
	);

	assert.deepEqual(await bindings[GENERIC_TOOL_NAME]?.({}, BINDING_SIGNAL), {
		text: "safe",
		content: [{ type: "text", text: "safe" }],
	});
	assert.equal(reported.at(-1)?.result, undefined);
	assert.doesNotThrow(() => JSON.stringify(reported));

	const throwingResult = Object.defineProperties(
		{ content: [{ type: "text", text: "still safe" }] },
		{
			details: {
				enumerable: true,
				get() {
					throw new Error("details getter");
				},
			},
			usage: {
				enumerable: true,
				get() {
					throw new Error("usage getter");
				},
			},
		},
	) as NestedToolRuntimeResult;
	const throwingBindings = createGenericBindings(
		[catalogEntry(GENERIC_TOOL_NAME)],
		toolExecutor(async (request) => dispatchResult(request, throwingResult)),
	);
	await assert.doesNotReject(async () => {
		assert.deepEqual(await throwingBindings[GENERIC_TOOL_NAME]?.({}, BINDING_SIGNAL), {
			text: "still safe",
			content: [{ type: "text", text: "still safe" }],
		});
	});
});

test("generic final errors become catchable ToolCallError after native finalization", async () => {
	const bindings = createGenericBindings(
		[catalogEntry(GENERIC_TOOL_NAME), catalogEntry(OTHER_GENERIC_TOOL_NAME)],
		toolExecutor(async (request) => {
			if (request.name === OTHER_GENERIC_TOOL_NAME) {
				return dispatchResult(request, { content: [{ type: "image", data: "x" }] }, true);
			}
			return dispatchResult(
				request,
				{
					content: [
						{ type: "text", text: "patched " },
						{ type: "text", text: "failure" },
						{ type: "text", text: 42 },
					],
				},
				true,
			);
		}),
	);

	for (const [name, message] of [
		[GENERIC_TOOL_NAME, "patched failure"],
		[OTHER_GENERIC_TOOL_NAME, GENERIC_FAILED_MESSAGE],
	] as const) {
		let caught: unknown;
		try {
			await bindings[name]?.({}, BINDING_SIGNAL);
		} catch (error) {
			caught = error;
		}
		assert.ok(caught instanceof ToolCallError);
		assert.equal(caught.toolName, name);
		assert.equal(caught.message, message);
	}
});
