import { strict as assert } from "node:assert";
import test from "node:test";

import {
	type Theme,
	ToolExecutionComponent,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { createDeltaDetails, createSnapshotDetails } from "../src/dispatch-details.ts";
import type { PtcRenderContext } from "../src/renderer.ts";
import type { PtcPartialResult, PtcToolResult } from "../src/transport.ts";
import {
	CALL_RENDER_FAILURE,
	CHILD_RENDER_FAILURE,
	CONSTRUCTOR_FAILURE,
	CONTROLLED_TOOL_NAME_CASES,
	createRenderContext,
	createTool,
	DESCRIPTION,
	definitionRegistry,
	EXTENDED_RENDER_CONTROL,
	type HostToolDefinition,
	INVALIDATE_FAILURE,
	MAX_FALLBACK_RENDER_BYTES,
	OUTER_FALLBACK_MARKER,
	OUTER_INVALIDATE_FAILURE,
	OVERSIZED_TOOL_NAME,
	RAW_CONTROL_SEQUENCES,
	RAW_VISIBLE_PREFIX,
	RAW_VISIBLE_SUFFIX,
	RAW_VISIBLE_TEXT,
	RENDER_TOOL_CALL_ID,
	RESULT_RENDER_FAILURE,
	render,
	renderRaw,
	resultWith,
	THEME,
} from "./support/renderer-harness.ts";

test("ptc root contains child rendering failures", () => {
	const tool = createTool();
	const context = createRenderContext(false);
	Object.assign(context, {
		createDefinitions: () =>
			definitionRegistry({
				read: {
					name: "read",
					renderCall: () => ({
						invalidate: () => undefined,
						render: () => {
							throw new Error(CHILD_RENDER_FAILURE);
						},
					}),
				},
			}),
	});
	const output = render(
		tool.renderResult(
			{
				content: [{ type: "text", text: "ignored" }],
				details: createDeltaDetails(DESCRIPTION, {
					id: 1,
					name: "read",
					args: { path: "unsafe.txt" },
					status: "start",
				}),
			},
			{ expanded: false, isPartial: true },
			THEME,
			context,
		),
	);

	assert.match(output, /execution/);
	assert.match(output, new RegExp(CHILD_RENDER_FAILURE));
	assert.doesNotMatch(output, /unsafe\.txt/);
});

test("ptc fallback sanitizes and bounds arbitrary tool names", () => {
	const tool = createTool();
	for (const name of CONTROLLED_TOOL_NAME_CASES) {
		const output = renderRaw(
			tool.renderResult(
				resultWith([{ id: 1, name, args: {}, status: "ok" }]),
				{ expanded: false, isPartial: false },
				THEME,
				createRenderContext(false),
			),
		);

		assert.equal(output.includes(name), false, JSON.stringify(output));
		assert.match(output, /beforeafter/);
	}

	const oversizedOutput = renderRaw(
		tool.renderResult(
			resultWith([{ id: 1, name: OVERSIZED_TOOL_NAME, args: {}, status: "ok" }]),
			{ expanded: false, isPartial: false },
			THEME,
			createRenderContext(false),
		),
	);
	assert.ok(Buffer.byteLength(oversizedOutput, "utf8") <= MAX_FALLBACK_RENDER_BYTES);
	assert.equal(oversizedOutput.includes(OVERSIZED_TOOL_NAME), false);
});

test("ptc sanitizes raw CSI, OSC, and APC across every display channel", () => {
	const tool = createTool();
	for (const control of RAW_CONTROL_SEQUENCES) {
		const controlled = `${RAW_VISIBLE_PREFIX}${control}${RAW_VISIBLE_SUFFIX}`;
		const context = createRenderContext(false, true);
		const output = renderRaw(
			tool.renderResult(
				{
					content: [{ type: "text", text: "ignored" }],
					details: {
						schemaVersion: 2,
						description: DESCRIPTION,
						mode: "snapshot",
						dispatches: [
							{
								id: 1,
								name: "read",
								args: { path: controlled },
								status: "err",
								preview: controlled,
							},
						],
						compatibilityError: controlled,
						executionError: controlled,
					},
				},
				{ expanded: false, isPartial: false },
				THEME,
				context,
			),
		);

		assert.equal(output.includes(control), false, JSON.stringify(output));
		assert.doesNotMatch(output, /unsafe-title|unsafe\.invalid|pi:unsafe/);
		assert.match(output, new RegExp(RAW_VISIBLE_TEXT));
	}
});

test("outer fallbacks and renderer diagnostics strip extended terminal controls", () => {
	const tool = createTool();
	const fallbackOutput = renderRaw(
		tool.renderResult(
			{
				content: [{ type: "text", text: EXTENDED_RENDER_CONTROL }],
				details: undefined,
			} as unknown as PtcToolResult,
			{ expanded: false, isPartial: false },
			THEME,
			createRenderContext(false, true),
		),
	);
	const diagnosticContext = createRenderContext(false);
	Object.assign(diagnosticContext, {
		createDefinitions: () =>
			definitionRegistry({
				read: {
					name: "read",
					renderCall: () => {
						throw new Error(EXTENDED_RENDER_CONTROL);
					},
				},
			}),
	});
	const diagnosticOutput = renderRaw(
		tool.renderResult(
			{
				content: [{ type: "text", text: "ignored" }],
				details: createDeltaDetails(DESCRIPTION, {
					id: 1,
					name: "read",
					args: { path: "safe.txt" },
					status: "start",
				}),
			},
			{ expanded: false, isPartial: true },
			THEME,
			diagnosticContext,
		),
	);

	for (const output of [fallbackOutput, diagnosticOutput]) {
		assert.equal(output.includes("\u001b"), false);
		assert.equal(output.includes("\u0007"), false);
		assert.equal(output.includes("\u009b"), false);
		assert.match(output, new RegExp(RAW_VISIBLE_TEXT));
	}
});

test("constructor failures stay inside the real outer tool renderer", () => {
	const tool = createTool();
	const hostileTool = {
		...tool,
		renderResult(
			result: PtcPartialResult | PtcToolResult,
			options: ToolRenderResultOptions,
			theme: Theme,
			context: PtcRenderContext,
		) {
			return tool.renderResult(result, options, theme, {
				...context,
				createDefinitions: () => {
					throw new Error(CONSTRUCTOR_FAILURE);
				},
			});
		},
	};
	const outer = new ToolExecutionComponent(
		"ptc",
		RENDER_TOOL_CALL_ID,
		{ code: OUTER_FALLBACK_MARKER, description: DESCRIPTION },
		{ showImages: false },
		hostileTool as unknown as HostToolDefinition,
		{ requestRender: () => undefined } as TUI,
		process.cwd(),
	);
	outer.markExecutionStarted();
	outer.setArgsComplete();
	outer.updateResult(
		{
			content: [{ type: "text", text: OUTER_FALLBACK_MARKER }],
			details: createSnapshotDetails(DESCRIPTION, [
				{ id: 1, name: "read", args: { path: "safe.txt" }, status: "start" },
			]),
			isError: false,
		},
		false,
	);
	const output = render(outer);

	assert.match(output, new RegExp(CONSTRUCTOR_FAILURE));
	assert.doesNotMatch(output, new RegExp(OUTER_FALLBACK_MARKER));
});

test("call and result slot failures become sanitized diagnostics", () => {
	const tool = createTool();
	for (const stage of ["call", "result"] as const) {
		const context = createRenderContext(false);
		const failure = stage === "call" ? CALL_RENDER_FAILURE : RESULT_RENDER_FAILURE;
		Object.assign(context, {
			createDefinitions: () =>
				definitionRegistry({
					read: {
						name: "read",
						renderCall: () => {
							if (stage === "call") throw new Error(failure);
							return new Text("safe", 0, 0);
						},
						renderResult: () => {
							throw new Error(failure);
						},
					},
				}),
		});
		const output = renderRaw(
			tool.renderResult(
				{
					content: [{ type: "text", text: "ignored" }],
					details: createDeltaDetails(DESCRIPTION, {
						id: 1,
						name: "read",
						args: { path: "safe.txt" },
						status: "ok",
						preview: "done",
					}),
				},
				{ expanded: false, isPartial: false },
				THEME,
				context,
			),
		);

		assert.match(output, /execution/);
		assert.match(output, new RegExp(RAW_VISIBLE_TEXT));
		assert.equal(output.includes("\u001b"), false);
		assert.equal(output.includes("\u0007"), false);
	}
});

test("slot and invalidate failures become bounded diagnostics", () => {
	const tool = createTool();
	let nestedInvalidate: (() => void) | undefined;
	const context = createRenderContext(false);
	Object.assign(context, {
		createDefinitions: () =>
			definitionRegistry({
				read: {
					name: "read",
					renderCall: (_args: unknown, _theme: Theme, slot: { invalidate(): void }) => {
						nestedInvalidate = slot.invalidate;
						return {
							invalidate: () => {
								throw new Error(INVALIDATE_FAILURE);
							},
							render: () => ["safe"],
						};
					},
				},
			}),
	});
	const root = tool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: createDeltaDetails(DESCRIPTION, {
				id: 1,
				name: "read",
				args: { path: "safe.txt" },
				status: "start",
			}),
		},
		{ expanded: false, isPartial: true },
		THEME,
		context,
	);

	assert.doesNotThrow(() => nestedInvalidate?.());
	assert.match(render(root), new RegExp(INVALIDATE_FAILURE));

	let outerInvalidate: (() => void) | undefined;
	const outerContext = {
		...createRenderContext(false),
		invalidate: () => {
			throw new Error(OUTER_INVALIDATE_FAILURE);
		},
	};
	Object.assign(outerContext, {
		createDefinitions: () =>
			definitionRegistry({
				read: {
					name: "read",
					renderCall: (_args: unknown, _theme: Theme, slot: { invalidate(): void }) => {
						outerInvalidate = slot.invalidate;
						return new Text("safe", 0, 0);
					},
				},
			}),
	});
	const outerRoot = tool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: createDeltaDetails(DESCRIPTION, {
				id: 1,
				name: "read",
				args: { path: "safe.txt" },
				status: "start",
			}),
		},
		{ expanded: false, isPartial: true },
		THEME,
		outerContext,
	);
	assert.doesNotThrow(() => outerInvalidate?.());
	assert.match(render(outerRoot), new RegExp(OUTER_INVALIDATE_FAILURE));
});
