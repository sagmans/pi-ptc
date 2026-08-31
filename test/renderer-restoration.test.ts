import { strict as assert } from "node:assert";
import test from "node:test";

import { Text } from "@earendil-works/pi-tui";

import type { DispatchProgress } from "../src/dispatch-contract.ts";
import { createDeltaDetails } from "../src/dispatch-details.ts";
import { attachPtcRenderDispatches } from "../src/renderer.ts";
import type { PtcPartialResult, PtcToolResult } from "../src/transport.ts";
import {
	createFreshOuter,
	createRenderContext,
	createTool,
	DESCRIPTION,
	definitionRegistry,
	EXPECTED_SINGLE_RENDER_COUNT,
	LIVE_EDIT_ENTRY_LIMIT,
	LIVE_WRITE_CONTENT,
	LOSSY_EDIT_NEW_PREFIX,
	LOSSY_EDIT_OLD_PREFIX,
	LOSSY_EDIT_PATH,
	LOSSY_EDIT_REPLACEMENT,
	loadDispatchFixture,
	NATIVE_EDIT_RENDER_MARKER,
	NATIVE_WRITE_RENDER_MARKER,
	OMITTED_RENDER_BUDGET_BYTES,
	OVERSIZED_LIVE_EDIT_TEXT,
	RECONSTRUCTION_IDLE_MS,
	RECONSTRUCTION_OUTER_MARKER,
	render,
	resultWith,
	THEME,
} from "./support/renderer-harness.ts";

test("live write arguments use native rendering while restored redacted rows use a safe fallback", () => {
	const tool = createTool();
	const rawDispatch: DispatchProgress = {
		id: 1,
		name: "write",
		args: { path: "live.txt", content: LIVE_WRITE_CONTENT },
		status: "start",
	};
	const details = createDeltaDetails(DESCRIPTION, rawDispatch);
	attachPtcRenderDispatches(details, [rawDispatch]);
	let nativeRenderCalls = 0;
	const createDefinitions = () =>
		definitionRegistry({
			write: {
				name: "write",
				renderCall: (args: { content?: string }) => {
					nativeRenderCalls += 1;
					return new Text(`${NATIVE_WRITE_RENDER_MARKER}: ${args.content ?? ""}`, 0, 0);
				},
			},
		});
	const liveContext = createRenderContext(false);
	Object.assign(liveContext, { createDefinitions });
	const liveOutput = render(
		tool.renderResult(
			{ content: [{ type: "text", text: "ignored" }], details },
			{ expanded: false, isPartial: true },
			THEME,
			liveContext,
		),
	);

	assert.match(liveOutput, new RegExp(NATIVE_WRITE_RENDER_MARKER));
	assert.match(liveOutput, new RegExp(LIVE_WRITE_CONTENT));
	assert.equal(nativeRenderCalls, 1);
	const restoredContext = createRenderContext(false);
	Object.assign(restoredContext, { createDefinitions });
	const restoredDetails = JSON.parse(JSON.stringify(details)) as PtcPartialResult["details"];
	const restoredOutput = render(
		tool.renderResult(
			{ content: [{ type: "text", text: "ignored" }], details: restoredDetails },
			{ expanded: false, isPartial: true },
			THEME,
			restoredContext,
		),
	);

	assert.match(restoredOutput, /write live\.txt/);
	assert.doesNotMatch(restoredOutput, new RegExp(NATIVE_WRITE_RENDER_MARKER));
	assert.doesNotMatch(restoredOutput, new RegExp(LIVE_WRITE_CONTENT));
	assert.equal(nativeRenderCalls, 1);
});

test("lossy live edit projections use a safe fallback when terminal render data is omitted", () => {
	const tool = createTool();
	const lossyEditCases = [
		[{ oldText: OVERSIZED_LIVE_EDIT_TEXT, newText: LOSSY_EDIT_REPLACEMENT }],
		Array.from({ length: LIVE_EDIT_ENTRY_LIMIT + 1 }, (_, index) => ({
			oldText: `${LOSSY_EDIT_OLD_PREFIX}-${index}`,
			newText: `${LOSSY_EDIT_NEW_PREFIX}-${index}`,
		})),
	];

	for (const edits of lossyEditCases) {
		const rawDispatch: DispatchProgress = {
			id: 1,
			name: "edit",
			args: { path: LOSSY_EDIT_PATH, edits },
			status: "ok",
			result: { content: [], isError: false },
		};
		const details = createDeltaDetails(DESCRIPTION, rawDispatch, OMITTED_RENDER_BUDGET_BYTES);
		attachPtcRenderDispatches(details, [rawDispatch]);
		let nativeRenderCalls = 0;
		const context = createRenderContext(false);
		Object.assign(context, {
			createDefinitions: () =>
				definitionRegistry({
					edit: {
						name: "edit",
						renderShell: "self",
						renderCall: () => {
							nativeRenderCalls += 1;
							return new Text(NATIVE_EDIT_RENDER_MARKER, 0, 0);
						},
					},
				}),
		});
		const output = render(
			tool.renderResult(
				{ content: [{ type: "text", text: "ignored" }], details },
				{ expanded: false, isPartial: false },
				THEME,
				context,
			),
		);

		assert.equal(details.dispatches[0]?.renderOmitted, "budget");
		assert.match(output, /edit lossy\.txt/);
		assert.doesNotMatch(output, new RegExp(NATIVE_EDIT_RENDER_MARKER));
		assert.equal(nativeRenderCalls, 0);
	}
});

test("fresh outer rows reconstruct version 2 native output without hidden transport content", async () => {
	const details = JSON.parse(JSON.stringify(loadDispatchFixture("version-2-success.json")));
	const restored = createFreshOuter(details);
	const output = render(restored.component);

	assert.match(output, /read note\.txt/);
	assert.match(output, /restored read content/);
	assert.match(output, /edit src\/example\.ts/);
	assert.match(output, /-old/);
	assert.match(output, /\+new/);
	assert.match(output, /read image\.png/);
	assert.match(output, /image\/png/);
	assert.match(output, /\$ printf omitted/);
	assert.match(output, /preview-only output/);
	assert.doesNotMatch(output, new RegExp(RECONSTRUCTION_OUTER_MARKER));
	assert.ok(output.indexOf("read note.txt") < output.indexOf("edit src/example.ts"));
	assert.ok(output.indexOf("edit src/example.ts") < output.indexOf("read image.png"));
	const requestsAfterRestore = restored.renderRequests();
	await new Promise((resolve) => setTimeout(resolve, RECONSTRUCTION_IDLE_MS));
	assert.equal(restored.renderRequests(), requestsAfterRestore);
});

test("fresh outer rows preserve nested and outer error order after JSON reload", () => {
	const details = JSON.parse(JSON.stringify(loadDispatchFixture("version-2-errors.json")));
	const output = render(createFreshOuter(details, true).component);

	assert.match(output, /nested fixture failure/);
	assert.match(output, /outer fixture failure/);
	assert.ok(output.indexOf("nested fixture failure") < output.indexOf("outer fixture failure"));
	assert.doesNotMatch(output, new RegExp(RECONSTRUCTION_OUTER_MARKER));
});

test("fresh outer rows migrate historical IDs and surface malformed details", () => {
	const legacy = JSON.parse(JSON.stringify(loadDispatchFixture("legacy-no-id.json")));
	const malformed = JSON.parse(JSON.stringify(loadDispatchFixture("version-2-malformed.json")));
	const legacyOutput = render(createFreshOuter(legacy).component);
	const malformedOutput = render(createFreshOuter(malformed).component);

	assert.equal(legacyOutput.match(/read legacy\.txt/g)?.length, EXPECTED_SINGLE_RENDER_COUNT);
	assert.match(legacyOutput, /legacy restored output/);
	assert.match(legacyOutput, /\$ printf legacy/);
	assert.match(legacyOutput, /legacy bash output/);
	assert.match(legacyOutput, /display/);
	assert.match(malformedOutput, /read valid\.txt/);
	assert.match(malformedOutput, /valid row survives/);
	assert.match(malformedOutput, /display/);
});

test("ptc uses Pi native read ranges instead of custom status marks", () => {
	const tool = createTool();
	const result = resultWith([
		{
			id: 1,
			name: "read",
			args: { path: "package.json", offset: 251, limit: 250 },
			status: "ok",
		},
	]);

	const output = render(
		tool.renderResult(
			result,
			{ expanded: false, isPartial: false },
			THEME,
			createRenderContext(false),
		),
	);

	assert.match(output, /read package\.json:251-500/);
	assert.doesNotMatch(output, /✓/);
});

test("ptc preserves the failed native tool row when the outer execution fails", () => {
	const tool = createTool();
	const context = createRenderContext(false);
	const nestedFailure = resultWith([
		{
			id: 1,
			name: "bash",
			args: { command: "false" },
			status: "err",
			preview: "Command exited with code 1",
		},
	]);
	context.lastComponent = tool.renderResult(
		nestedFailure,
		{ expanded: false, isPartial: true },
		THEME,
		context,
	);
	context.isError = true;

	const output = render(
		tool.renderResult(
			{
				content: [{ type: "text", text: "ptc failed (runtime): tool failed" }],
				details: undefined,
			} as unknown as PtcToolResult,
			{ expanded: false, isPartial: false },
			THEME,
			context,
		),
	);

	assert.match(output, /\$ false/);
	assert.match(output, /Command exited with code 1/);
	assert.doesNotMatch(output, /Execution failed/);
});
