import { strict as assert } from "node:assert";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { createDeltaDetails } from "../src/dispatch-details.ts";
import type { PtcPartialResult } from "../src/transport.ts";
import {
	CONVERTED_IMAGE_DATA,
	createRenderContext,
	createTool,
	DESCRIPTION,
	definitionRegistry,
	EXPECTED_SINGLE_RENDER_COUNT,
	IMAGE_RENDER_WIDTH,
	IMAGE_RESIZED_WIDTH,
	JPEG_IMAGE_DATA,
	PNG_IMAGE_DATA,
	RENDERER_SOURCE,
	render,
	THEME,
} from "./support/renderer-harness.ts";

test("ptc renderer owns public-contract rows without nested host components", () => {
	assert.doesNotMatch(RENDERER_SOURCE, /ToolExecutionComponent/);
	assert.doesNotMatch(RENDERER_SOURCE, /\bas TUI\b/);
});

test("ptc keeps stable rows across interleaved deltas, expansion, and resize", () => {
	const tool = createTool();
	const context = createRenderContext(false);
	const second = tool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: createDeltaDetails(DESCRIPTION, {
				id: 2,
				name: "bash",
				args: { command: "npm test" },
				status: "start",
			}),
		},
		{ expanded: false, isPartial: true },
		THEME,
		context,
	);
	const first = tool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: createDeltaDetails(DESCRIPTION, {
				id: 1,
				name: "read",
				args: { path: "package.json" },
				status: "start",
			}),
		},
		{ expanded: false, isPartial: true },
		THEME,
		context,
	);

	assert.equal(first, second);
	const collapsed = render(first, 80);
	assert.ok(collapsed.indexOf("read package.json") < collapsed.indexOf("$ npm test"));
	context.expanded = true;
	const expanded = tool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: createDeltaDetails(DESCRIPTION, {
				id: 1,
				name: "read",
				args: { path: "package.json" },
				status: "start",
			}),
		},
		{ expanded: true, isPartial: true },
		THEME,
		context,
	);
	assert.equal(expanded, first);
	assert.match(render(expanded, 60), /read package\.json/);
	assert.match(render(expanded, 140), /read package\.json/);
});

test("unchanged deltas and width-only renders do not rebuild native slots", () => {
	const tool = createTool();
	const context = createRenderContext(false);
	let callRenders = 0;
	let resultRenders = 0;
	Object.assign(context, {
		createDefinitions: () =>
			definitionRegistry({
				read: {
					name: "read",
					renderCall: (_args: unknown, _theme: Theme, slot: { lastComponent?: Component }) => {
						callRenders += 1;
						return slot.lastComponent ?? new Text("read stable.txt", 0, 0);
					},
					renderResult: (
						_result: unknown,
						_options: unknown,
						_theme: Theme,
						slot: { lastComponent?: Component },
					) => {
						resultRenders += 1;
						return slot.lastComponent ?? new Text("done", 0, 0);
					},
				},
			}),
	});
	const update: PtcPartialResult = {
		content: [{ type: "text", text: "ignored" }],
		details: createDeltaDetails(DESCRIPTION, {
			id: 1,
			name: "read",
			args: { path: "stable.txt" },
			status: "ok",
			preview: "done",
		}),
	};

	const root = tool.renderResult(update, { expanded: false, isPartial: false }, THEME, context);
	tool.renderResult(update, { expanded: false, isPartial: false }, THEME, context);
	render(root, 60);
	render(root, 140);

	assert.equal(callRenders, EXPECTED_SINGLE_RENDER_COUNT);
	assert.equal(resultRenders, EXPECTED_SINGLE_RENDER_COUNT);
});

test("image conversion is deduplicated and bound to the current row generation", async () => {
	const tool = createTool();
	let resolveConversion!: (value: { data: string; mimeType: string }) => void;
	const conversion = new Promise<{ data: string; mimeType: string }>((resolve) => {
		resolveConversion = resolve;
	});
	let conversionCalls = 0;
	let invalidations = 0;
	const imageWidths: number[] = [];
	const context = {
		...createRenderContext(false),
		invalidate: () => {
			invalidations += 1;
		},
		showImages: true,
	};
	Object.assign(context, {
		convertImage: async () => {
			conversionCalls += 1;
			return await conversion;
		},
		createDefinitions: () =>
			definitionRegistry({
				read: {
					name: "read",
					renderCall: () => new Text("read image.jpg", 0, 0),
					renderResult: () => new Text("", 0, 0),
				},
			}),
		createImage: (_data: string, _mimeType: string, maxWidthCells: number) => {
			imageWidths.push(maxWidthCells);
			return new Text(`image:${maxWidthCells}`, 0, 0);
		},
		getImageProtocol: () => "kitty",
	});
	const imageResult = {
		content: [{ type: "image", data: JPEG_IMAGE_DATA, mimeType: "image/jpeg" }],
		isError: false,
	};
	const partial: PtcPartialResult = {
		content: [{ type: "text", text: "ignored" }],
		details: createDeltaDetails(DESCRIPTION, {
			id: 1,
			name: "read",
			args: { path: "image.jpg" },
			status: "start",
			result: imageResult,
		}),
	};
	const root = tool.renderResult(partial, { expanded: false, isPartial: true }, THEME, context);
	tool.renderResult(partial, { expanded: false, isPartial: true }, THEME, context);
	tool.renderResult(
		{
			...partial,
			details: createDeltaDetails(DESCRIPTION, {
				id: 1,
				name: "read",
				args: { path: "image.jpg" },
				status: "ok",
				result: imageResult,
			}),
		},
		{ expanded: false, isPartial: false },
		THEME,
		context,
	);

	assert.equal(conversionCalls, 1);
	resolveConversion({ data: CONVERTED_IMAGE_DATA, mimeType: "image/png" });
	await conversion;
	await Promise.resolve();
	assert.equal(invalidations, 1);
	assert.match(render(root, IMAGE_RENDER_WIDTH), new RegExp(`image:${IMAGE_RENDER_WIDTH}`));
	assert.match(render(root, IMAGE_RESIZED_WIDTH), new RegExp(`image:${IMAGE_RESIZED_WIDTH}`));
	assert.deepEqual(imageWidths, [IMAGE_RENDER_WIDTH, IMAGE_RESIZED_WIDTH]);

	let resolveStale!: (value: { data: string; mimeType: string }) => void;
	const staleConversion = new Promise<{ data: string; mimeType: string }>((resolve) => {
		resolveStale = resolve;
	});
	let staleInvalidations = 0;
	const staleContext = {
		...createRenderContext(false),
		invalidate: () => {
			staleInvalidations += 1;
		},
		showImages: true,
	};
	Object.assign(staleContext, {
		convertImage: async () => await staleConversion,
		createDefinitions: () =>
			definitionRegistry({
				read: {
					name: "read",
					renderCall: () => new Text("read image", 0, 0),
					renderResult: () => new Text("", 0, 0),
				},
			}),
		createImage: () => new Text("image", 0, 0),
		getImageProtocol: () => "kitty",
	});
	tool.renderResult(partial, { expanded: false, isPartial: true }, THEME, staleContext);
	tool.renderResult(
		{
			...partial,
			details: createDeltaDetails(DESCRIPTION, {
				id: 1,
				name: "read",
				args: { path: "replacement.png" },
				status: "ok",
				result: {
					content: [{ type: "image", data: PNG_IMAGE_DATA, mimeType: "image/png" }],
					isError: false,
				},
			}),
		},
		{ expanded: false, isPartial: false },
		THEME,
		staleContext,
	);
	resolveStale({ data: CONVERTED_IMAGE_DATA, mimeType: "image/png" });
	await staleConversion;
	await Promise.resolve();
	assert.equal(staleInvalidations, 0);
});
