import { strict as assert } from "node:assert";
import test from "node:test";

import type { DispatchProgress } from "../src/bridge.ts";
import { createSnapshotDetails } from "../src/dispatch-details.ts";
import { attachPtcRenderDispatches } from "../src/renderer.ts";
import type { PtcPartialResult, PtcToolResult } from "../src/transport.ts";
import {
	createRenderContext,
	createTool,
	DESCRIPTION,
	NATIVE_READ_CONTENT,
	OMITTED_READ_CONTENT,
	OMITTED_RENDER_BUDGET_BYTES,
	PROGRAM,
	render,
	resultWith,
	THEME,
} from "./support/renderer-harness.ts";

test("ptc hides its call shell, description, program, and outer return", () => {
	const tool = createTool();
	const args = { code: PROGRAM, description: DESCRIPTION };
	const emptyResult = resultWith([]);

	assert.equal(tool.renderShell, "self");
	assert.equal(render(tool.renderCall(args, THEME, createRenderContext(false))), "");
	assert.equal(render(tool.renderCall(args, THEME, createRenderContext(true))), "");
	assert.equal(
		render(
			tool.renderResult(
				emptyResult,
				{ expanded: false, isPartial: false },
				THEME,
				createRenderContext(false),
			),
		),
		"",
	);
});

test("ptc renders each running dispatch as its own native row", () => {
	const tool = createTool();
	const partial: PtcPartialResult = {
		content: [{ type: "text", text: "ignored" }],
		details: createSnapshotDetails(DESCRIPTION, [
			{ id: 1, name: "read", args: { path: "package.json" }, status: "start" },
			{ id: 2, name: "bash", args: { command: "npm test" }, status: "start" },
		]),
	};

	const output = render(
		tool.renderResult(
			partial,
			{ expanded: false, isPartial: true },
			THEME,
			createRenderContext(false),
		),
	);

	assert.match(output, /read package\.json/);
	assert.match(output, /\$ npm test/);
	assert.doesNotMatch(output, /…|✓|✗/);
});

test("ptc renders compact tool-specific output previews", () => {
	const tool = createTool();
	const result = resultWith([
		{ id: 1, name: "read", args: { path: "package.json" }, status: "ok", preview: "hidden" },
		{
			id: 2,
			name: "bash",
			args: { command: "npm test" },
			status: "ok",
			preview: "one\ntwo\nthree\nfour",
		},
		{
			id: 3,
			name: "grep",
			args: { pattern: "hit", path: "src" },
			status: "ok",
			preview: "a.ts:1:hit\nb.ts:2:hit\nc.ts:3:hit\nd.ts:4:hit",
		},
		{ id: 4, name: "edit", args: { path: "src/a.ts" }, status: "ok", preview: "hidden" },
	]);

	const output = render(
		tool.renderResult(
			result,
			{ expanded: false, isPartial: false },
			THEME,
			createRenderContext(false),
		),
	);

	assert.match(output, /read package\.json/);
	assert.match(output, /\$ npm test/);
	assert.match(output, /one\ntwo\nthree\nfour/);
	assert.match(output, /grep \/hit\/ in src/);
	assert.match(output, /a\.ts:1:hit/);
	assert.match(output, /edit src\/a\.ts/);
	assert.doesNotMatch(output, /✓|✗/);
});

test("ptc renders failed dispatch errors without exposing the transport", () => {
	const tool = createTool();
	const result = resultWith([
		{
			id: 1,
			name: "read",
			args: { path: "missing.txt" },
			status: "err",
			preview: "file not found",
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

	assert.match(output, /read missing\.txt/);
	assert.match(output, /file not found/);
	assert.doesNotMatch(output, /✗/);
});

test("ptc expanded rows use the native tool output", () => {
	const tool = createTool();
	const result = resultWith([
		{
			id: 1,
			name: "grep",
			args: {
				pattern: "needle",
				path: "src",
				options: { literal: true, limits: [1, 2] },
			},
			status: "ok",
			preview: "one\ntwo\nthree\nfour",
		},
	]);

	const output = render(
		tool.renderResult(
			result,
			{ expanded: true, isPartial: false },
			THEME,
			createRenderContext(true),
		),
	);

	assert.match(output, /grep \/needle\/ in src/);
	assert.match(output, /one\ntwo\nthree\nfour/);
	assert.doesNotMatch(output, /Arguments|Output|✓/);
});

test("ptc renders persisted native results after a JSON reload without an attachment", () => {
	const tool = createTool();
	const details = createSnapshotDetails(DESCRIPTION, [
		{
			id: 1,
			name: "read",
			args: { path: "note.txt" },
			status: "ok",
			result: {
				content: [{ type: "text", text: NATIVE_READ_CONTENT }],
				details: undefined,
				isError: false,
			},
		},
	]);
	const result: PtcToolResult = {
		content: [{ type: "text", text: "ignored" }],
		details: JSON.parse(JSON.stringify(details)) as PtcToolResult["details"],
	};

	const output = render(
		tool.renderResult(
			result,
			{ expanded: true, isPartial: false },
			THEME,
			createRenderContext(true),
		),
	);

	assert.match(output, new RegExp(NATIVE_READ_CONTENT));
});

test("ptc attachments cannot restore a result omitted from persisted details", () => {
	const tool = createTool();
	const rawDispatch: DispatchProgress = {
		id: 1,
		name: "read",
		args: { path: "note.txt" },
		status: "ok",
		result: {
			content: [{ type: "text", text: OMITTED_READ_CONTENT }],
			isError: false,
		},
	};
	const details = createSnapshotDetails(
		DESCRIPTION,
		[rawDispatch],
		undefined,
		OMITTED_RENDER_BUDGET_BYTES,
	);
	attachPtcRenderDispatches(details, [rawDispatch]);
	const result: PtcToolResult = {
		content: [{ type: "text", text: "ignored" }],
		details,
	};

	const output = render(
		tool.renderResult(
			result,
			{ expanded: true, isPartial: false },
			THEME,
			createRenderContext(true),
		),
	);

	assert.doesNotMatch(output, new RegExp(OMITTED_READ_CONTENT));
	assert.deepEqual(details.dispatches, [
		{
			id: rawDispatch.id,
			name: rawDispatch.name,
			args: rawDispatch.args,
			status: rawDispatch.status,
			renderOmitted: "budget",
		},
	]);
});
