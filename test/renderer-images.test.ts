import { strict as assert } from "node:assert";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";

import type { DispatchProgress } from "../src/bridge.ts";
import { createDeltaDetails } from "../src/dispatch-details.ts";
import { attachPtcRenderDispatches } from "../src/renderer.ts";
import { createPtcTool, type PtcToolResult } from "../src/transport.ts";
import {
	CALL_RENDER_FAILURE,
	CALLBACK_TEST_INTERVAL_MS,
	createRenderContext,
	createTool,
	DESCRIPTION,
	definitionRegistry,
	IMAGE_FALLBACK_TEXT,
	LIMITS,
	ORIGINAL_THEME_TEXT,
	PNG_IMAGE_DATA,
	RAW_VISIBLE_TEXT,
	render,
	rendererCatalogEntry,
	renderRaw,
	resultWith,
	THEME,
	UPDATED_THEME_TEXT,
} from "./support/renderer-harness.ts";

test("missing arbitrary result renderer sanitizes bounded live fallback for incompatible details", () => {
	const rawDetails: Record<string, unknown> = { stage: "final" };
	rawDetails.self = rawDetails;
	const rawDispatch: DispatchProgress = {
		id: 1,
		name: "custom-fallback",
		args: { path: "live.txt" },
		status: "ok",
		result: {
			content: [{ type: "text", text: CALL_RENDER_FAILURE }],
			details: rawDetails,
			isError: false,
		},
	};
	const details = createDeltaDetails(DESCRIPTION, rawDispatch);
	attachPtcRenderDispatches(details, [rawDispatch]);
	const output = renderRaw(
		createTool().renderResult(
			{ content: [{ type: "text", text: "ignored" }], details },
			{ expanded: false, isPartial: false },
			THEME,
			createRenderContext(false),
		),
	);

	assert.equal(details.dispatches[0]?.renderOmitted, "incompatible");
	assert.equal(output.includes("\u001b"), false);
	assert.match(output, new RegExp(RAW_VISIBLE_TEXT));
	assert.equal(JSON.stringify(details).includes(RAW_VISIBLE_TEXT), false);
});

test("live arbitrary images render when raw details are incompatible with persistence", () => {
	const rawDetails: Record<string, unknown> = { stage: "final" };
	rawDetails.self = rawDetails;
	const rawDispatch: DispatchProgress = {
		id: 1,
		name: "custom-image",
		args: {},
		status: "ok",
		result: {
			content: [{ type: "image", data: PNG_IMAGE_DATA, mimeType: "image/png" }],
			details: rawDetails,
			isError: false,
		},
	};
	const details = createDeltaDetails(DESCRIPTION, rawDispatch);
	attachPtcRenderDispatches(details, [rawDispatch]);
	const tool = createPtcTool({
		...LIMITS,
		definitionProvider: () => [
			rendererCatalogEntry("custom-image", {
				renderCall: () => new Text("custom image call", 0, 0),
				renderResult: () => new Text("", 0, 0),
			}),
		],
		createBindings: () => ({}),
	});
	const context = { ...createRenderContext(false), showImages: true };
	Object.assign(context, {
		createImage: () => new Text(IMAGE_FALLBACK_TEXT, 0, 0),
		getImageProtocol: () => null,
	});
	const output = render(
		tool.renderResult(
			{ content: [{ type: "text", text: "ignored" }], details },
			{ expanded: false, isPartial: false },
			THEME,
			context,
		),
	);

	assert.equal(details.dispatches[0]?.renderOmitted, "incompatible");
	assert.match(output, /custom image call/);
	assert.match(output, new RegExp(IMAGE_FALLBACK_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.equal(JSON.stringify(details).includes(PNG_IMAGE_DATA), false);
});

test("restored arbitrary history without attachments or provider uses generic fallback", () => {
	const tool = createTool();
	const restored = JSON.parse(
		JSON.stringify(
			resultWith([
				{
					id: 1,
					name: "restored/custom",
					args: { path: "restored.txt", token: "[REDACTED]" },
					status: "ok",
					result: {
						content: [{ type: "text", text: "restored generic result" }],
						isError: false,
					},
				},
			]),
		),
	) as PtcToolResult;
	const output = render(
		tool.renderResult(
			restored,
			{ expanded: false, isPartial: false },
			THEME,
			createRenderContext(false),
		),
	);

	assert.match(output, /restored\/custom restored\.txt/);
	assert.match(output, /restored generic result/);
});

test("image-only results keep a textual fallback when the terminal has no image protocol", () => {
	const tool = createTool();
	const context = {
		...createRenderContext(false),
		showImages: true,
	};
	Object.assign(context, {
		createDefinitions: () =>
			definitionRegistry({
				read: {
					name: "read",
					renderCall: () => new Text("read image.png", 0, 0),
					renderResult: () => new Text("", 0, 0),
				},
			}),
		createImage: () => new Text(IMAGE_FALLBACK_TEXT, 0, 0),
		getImageProtocol: () => null,
	});
	const output = render(
		tool.renderResult(
			{
				content: [{ type: "text", text: "ignored" }],
				details: createDeltaDetails(DESCRIPTION, {
					id: 1,
					name: "read",
					args: { path: "image.png" },
					status: "ok",
					result: {
						content: [{ type: "image", data: PNG_IMAGE_DATA, mimeType: "image/png" }],
						isError: false,
					},
				}),
			},
			{ expanded: false, isPartial: false },
			THEME,
			context,
		),
	);

	assert.match(output, new RegExp(IMAGE_FALLBACK_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("theme invalidation rebuilds native slots without retiring current callbacks", () => {
	const tool = createTool();
	let themeText = ORIGINAL_THEME_TEXT;
	let firstInvalidate: (() => void) | undefined;
	let outerInvalidations = 0;
	const mutableTheme = {
		...THEME,
		fg: (_color: string, _text: string) => themeText,
	} as Theme;
	const context = {
		...createRenderContext(false),
		invalidate: () => {
			outerInvalidations += 1;
		},
	};
	Object.assign(context, {
		createDefinitions: () =>
			definitionRegistry({
				read: {
					name: "read",
					renderCall: (
						_args: unknown,
						theme: Theme,
						slot: { invalidate(): void; lastComponent?: Component },
					) => {
						firstInvalidate ??= slot.invalidate;
						const text =
							slot.lastComponent instanceof Text ? slot.lastComponent : new Text("", 0, 0);
						text.setText(theme.fg("toolTitle", "read themed.txt"));
						return text;
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
				args: { path: "themed.txt" },
				status: "start",
			}),
		},
		{ expanded: false, isPartial: true },
		mutableTheme,
		context,
	);

	assert.match(render(root), new RegExp(ORIGINAL_THEME_TEXT));
	themeText = UPDATED_THEME_TEXT;
	root.invalidate();
	assert.match(render(root), new RegExp(UPDATED_THEME_TEXT));
	const invalidationsBeforeCallback = outerInvalidations;
	firstInvalidate?.();
	assert.equal(outerInvalidations, invalidationsBeforeCallback + 1);
});

test("partial rebuilds keep the active native renderer callback live", () => {
	const tool = createTool();
	let activeCallback: (() => void) | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;
	let outerInvalidations = 0;
	let resultRenders = 0;
	let root: Component | undefined;
	const context = {
		...createRenderContext(false),
		invalidate: () => {
			outerInvalidations += 1;
			root?.invalidate();
		},
	};
	Object.assign(context, {
		createDefinitions: () =>
			definitionRegistry({
				bash: {
					name: "bash",
					renderCall: () => new Text("bash", 0, 0),
					renderResult: (
						_result: unknown,
						_options: unknown,
						_theme: Theme,
						slot: { invalidate(): void; state: Record<string, unknown> },
					) => {
						resultRenders += 1;
						if (!slot.state.interval) {
							activeCallback = slot.invalidate;
							interval = setInterval(() => undefined, CALLBACK_TEST_INTERVAL_MS);
							slot.state.interval = interval;
						}
						return new Text(`working-${resultRenders}`, 0, 0);
					},
				},
			}),
	});
	try {
		for (const preview of ["first", "second"]) {
			root = tool.renderResult(
				{
					content: [{ type: "text", text: "ignored" }],
					details: createDeltaDetails(DESCRIPTION, {
						id: 1,
						name: "bash",
						args: { command: "sleep 1" },
						status: "start",
						preview,
					}),
				},
				{ expanded: false, isPartial: true },
				THEME,
				context,
			);
		}

		const invalidationsBeforeCallback = outerInvalidations;
		const rendersBeforeCallback = resultRenders;
		activeCallback?.();
		assert.equal(outerInvalidations, invalidationsBeforeCallback + 1);
		assert.equal(resultRenders, rendersBeforeCallback + 1);
	} finally {
		if (interval) clearInterval(interval);
	}
});
