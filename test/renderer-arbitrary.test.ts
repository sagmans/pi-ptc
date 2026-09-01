import { strict as assert } from "node:assert";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { DispatchProgress } from "../src/dispatch-contract.ts";
import { createDeltaDetails } from "../src/dispatch-details.ts";
import { attachPtcRenderDispatches } from "../src/renderer.ts";
import { createPtcTool } from "../src/transport.ts";
import {
	createRenderContext,
	DESCRIPTION,
	IMAGE_FALLBACK_TEXT,
	LIMITS,
	PNG_IMAGE_DATA,
	render,
	rendererCatalogEntry,
	resultWith,
	THEME,
} from "./support/renderer-harness.ts";

test("live arbitrary renderers receive raw arguments, raw error result, and final context", () => {
	const rawArgs = {
		token: "live renderer secret",
		nested: { exact: [1, 2, 3] },
	};
	const rawDetails: Record<string, unknown> = { final: true };
	rawDetails.self = rawDetails;
	const rawDispatch: DispatchProgress = {
		id: 1,
		name: "custom-error",
		args: rawArgs,
		status: "err",
		preview: "custom failed",
		result: {
			content: [{ type: "text", text: "final custom failure" }],
			details: rawDetails,
			isError: true,
		},
	};
	const details = createDeltaDetails(DESCRIPTION, rawDispatch);
	const rawRenderStore = attachPtcRenderDispatches(details, [rawDispatch]);
	let callArgs: unknown;
	let resultDetails: unknown;
	let resultOptions: { isPartial: boolean } | undefined;
	let resultContext: { isPartial: boolean; isError: boolean; args: unknown } | undefined;
	const entry = rendererCatalogEntry("custom-error", {
		renderCall(args: unknown) {
			callArgs = args;
			return new Text("custom error call", 0, 0);
		},
		renderResult(
			result: { details?: unknown },
			options: { isPartial: boolean },
			_theme: Theme,
			context: { isPartial: boolean; isError: boolean; args: unknown },
		) {
			resultDetails = result.details;
			resultOptions = options;
			resultContext = context;
			return new Text("custom error result", 0, 0);
		},
	});
	const tool = createPtcTool({
		...LIMITS,
		definitionProvider: () => [entry],
		rawRenderStore,
		createBindings: () => ({}),
	});
	const output = render(
		tool.renderResult(
			{ content: [{ type: "text", text: "ignored" }], details },
			{ expanded: false, isPartial: false },
			THEME,
			createRenderContext(false),
		),
	);

	assert.equal(details.dispatches[0]?.renderOmitted, "incompatible");
	assert.deepEqual(callArgs, rawArgs);
	assert.equal(resultDetails, rawDetails);
	assert.equal(resultOptions?.isPartial, false);
	assert.equal(resultContext?.isPartial, false);
	assert.equal(resultContext?.isError, true);
	assert.deepEqual(resultContext?.args, rawArgs);
	assert.match(output, /custom error call/);
	assert.match(output, /custom error result/);
	assert.equal(JSON.stringify(details).includes("live renderer secret"), false);
});

test("custom image-only and text-image results keep existing image behavior", () => {
	const entries = [
		rendererCatalogEntry("image-only", {
			renderCall: () => new Text("custom image-only call", 0, 0),
			renderResult: () => new Text("", 0, 0),
		}),
		rendererCatalogEntry("text-image", {
			renderCall: () => new Text("custom text-image call", 0, 0),
			renderResult: (result: { content: Array<{ type: string; text?: string }> }) =>
				new Text(result.content.find((block) => block.type === "text")?.text ?? "", 0, 0),
		}),
	];
	const tool = createPtcTool({
		...LIMITS,
		definitionProvider: () => entries,
		createBindings: () => ({}),
	});
	const context = { ...createRenderContext(false), showImages: true };
	Object.assign(context, {
		createImage: () => new Text(IMAGE_FALLBACK_TEXT, 0, 0),
		getImageProtocol: () => null,
	});
	const output = render(
		tool.renderResult(
			resultWith([
				{
					id: 1,
					name: "image-only",
					args: {},
					status: "ok",
					result: {
						content: [{ type: "image", data: PNG_IMAGE_DATA, mimeType: "image/png" }],
						isError: false,
					},
				},
				{
					id: 2,
					name: "text-image",
					args: {},
					status: "ok",
					result: {
						content: [
							{ type: "text", text: "custom mixed text" },
							{ type: "image", data: PNG_IMAGE_DATA, mimeType: "image/png" },
						],
						isError: false,
					},
				},
			]),
			{ expanded: false, isPartial: false },
			THEME,
			context,
		),
	);

	assert.match(output, /custom image-only call/);
	assert.match(output, /custom text-image call/);
	assert.match(output, /custom mixed text/);
	assert.equal(
		output.match(new RegExp(IMAGE_FALLBACK_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))
			?.length,
		2,
	);
});
