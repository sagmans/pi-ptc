import { strict as assert } from "node:assert";
import test from "node:test";

import { createSnapshotDetails } from "../src/dispatch-details.ts";
import type { PtcToolResult } from "../src/transport.ts";
import {
	ANSI_RED,
	ANSI_RESET,
	createRenderContext,
	createTool,
	DESCRIPTION,
	render,
	resultWith,
	THEME,
} from "./support/renderer-harness.ts";

test("ptc renders nested and outer failures independently", () => {
	const tool = createTool();
	const context = createRenderContext(false, true);
	const output = render(
		tool.renderResult(
			{
				content: [{ type: "text", text: "ptc failed (runtime): outer failure" }],
				details: createSnapshotDetails(
					DESCRIPTION,
					[
						{
							id: 1,
							name: "bash",
							args: { command: "false" },
							status: "err",
							preview: "nested failure",
						},
					],
					"outer failure",
				),
			},
			{ expanded: false, isPartial: false },
			THEME,
			context,
		),
	);

	assert.match(output, /nested failure/);
	assert.match(output, /outer failure/);
	assert.match(output, /execution/);
});

test("ptc strips terminal controls from nested args, previews, and execution errors", () => {
	const tool = createTool();
	const controlled = `${ANSI_RED}unsafe${ANSI_RESET}`;
	const result = resultWith([
		{
			id: 1,
			name: "bash",
			args: { command: controlled },
			status: "err",
			preview: controlled,
		},
	]);
	const nested = render(
		tool.renderResult(
			result,
			{ expanded: false, isPartial: false },
			THEME,
			createRenderContext(false),
		),
	);
	const executionError = render(
		tool.renderResult(
			{
				content: [{ type: "text", text: controlled }],
				details: undefined,
			} as unknown as PtcToolResult,
			{ expanded: false, isPartial: false },
			THEME,
			createRenderContext(false, true),
		),
	);

	assert.equal(nested.includes(ANSI_RED), false);
	assert.equal(nested.includes(ANSI_RESET), false);
	assert.equal(executionError.includes(ANSI_RED), false);
	assert.equal(executionError.includes(ANSI_RESET), false);
	assert.match(executionError, /execution/);
	assert.match(executionError, /unsafe/);
});
