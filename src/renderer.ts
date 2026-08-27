import {
	convertToPng,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type Theme,
	type ToolDefinition,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getCapabilities,
	Image,
	type ImageProtocol,
	Text,
} from "@earendil-works/pi-tui";

import type { DispatchProgress } from "./bridge.ts";
import {
	parseDispatchDetails,
	projectLiveDisplayArguments,
	sanitizeDisplayText,
} from "./dispatch-details.ts";
import type { JsonValue } from "./json.ts";
import type {
	PtcDefinitionRegistry,
	PtcRenderContext,
	PtcRendererRoot,
	PtcRowView,
} from "./renderer-contract.ts";
import { safeForeground } from "./renderer-diagnostics.ts";
import { SafePtcRoot } from "./renderer-root.ts";
import type { PtcParams, PtcPartialResult, PtcToolResult } from "./transport.ts";

export type {
	PtcDefinitionFactory,
	PtcDefinitionRegistry,
	PtcImageConverter,
	PtcImageFactory,
	PtcRenderContext,
} from "./renderer-contract.ts";

const PTC_ERROR_PREFIX = /^ptc failed \([^)]+\):\s*/;
const liveRenderArguments = new WeakMap<object, ReadonlyMap<number, JsonValue>>();

export function attachPtcRenderDispatches(
	details: object,
	dispatches: readonly DispatchProgress[],
): void {
	liveRenderArguments.set(
		details,
		new Map(
			dispatches.map((dispatch) => [
				dispatch.id,
				projectLiveDisplayArguments(dispatch.name, dispatch.args),
			]),
		),
	);
}

export function renderPtcCall(_args: PtcParams, _theme: Theme, context: PtcRenderContext): Text {
	const component =
		context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	component.setText("");
	return component;
}

export function renderPtcResult(
	result: PtcPartialResult | PtcToolResult,
	_options: ToolRenderResultOptions,
	theme: Theme,
	context: PtcRenderContext,
): Component {
	const root = getRoot(context, theme);
	const details = parseDispatchDetails(result.details);
	const attachedArguments =
		typeof result.details === "object" && result.details !== null
			? liveRenderArguments.get(result.details)
			: undefined;
	root.setView({
		expanded: context.expanded,
		showImages: context.showImages,
		theme,
		invalidate: context.invalidate,
	});
	for (const dispatch of details.dispatches) {
		const args = attachedArguments?.get(dispatch.id);
		root.updateDispatch(args === undefined ? dispatch : { ...dispatch, args });
	}
	root.setCompatibilityError(details.compatibilityError);
	root.setExecutionError(
		context.isError ? (details.executionError ?? getOuterExecutionError(result)) : undefined,
	);
	return root;
}

function getRoot(context: PtcRenderContext, theme: Theme): PtcRendererRoot {
	const existing = context.state.root;
	if (existing?.cwd === context.cwd) return existing;
	existing?.unmount();
	const view: PtcRowView = {
		expanded: context.expanded,
		showImages: context.showImages,
		theme,
		invalidate: context.invalidate,
	};
	let definitions: PtcDefinitionRegistry = {};
	let constructionFailure: unknown;
	try {
		definitions = (context.createDefinitions ?? createNativeDefinitions)(context.cwd);
	} catch (error) {
		constructionFailure = error;
	}
	const root = new SafePtcRoot(context.cwd, context.toolCallId, view, definitions, {
		convertImage: context.convertImage ?? convertToPng,
		createImage: context.createImage ?? createNativeImage,
		getImageProtocol: context.getImageProtocol ?? getNativeImageProtocol,
	});
	if (constructionFailure !== undefined) root.contain(constructionFailure);
	context.state.root = root;
	return root;
}

function createNativeDefinitions(cwd: string): PtcDefinitionRegistry {
	return {
		bash: createBashToolDefinition(cwd) as unknown as ToolDefinition,
		edit: createEditToolDefinition(cwd) as unknown as ToolDefinition,
		find: createFindToolDefinition(cwd) as unknown as ToolDefinition,
		grep: createGrepToolDefinition(cwd) as unknown as ToolDefinition,
		ls: createLsToolDefinition(cwd) as unknown as ToolDefinition,
		read: createReadToolDefinition(cwd) as unknown as ToolDefinition,
		write: createWriteToolDefinition(cwd) as unknown as ToolDefinition,
	};
}

function createNativeImage(
	data: string,
	mimeType: string,
	maxWidthCells: number,
	theme: Theme,
): Component {
	return new Image(
		data,
		mimeType,
		{ fallbackColor: (text) => safeForeground(theme, "toolOutput", text) },
		{ maxWidthCells },
	);
}

function getNativeImageProtocol(): ImageProtocol {
	return getCapabilities().images;
}

function getOuterExecutionError(result: PtcPartialResult | PtcToolResult): string {
	return sanitizeDisplayText(getTextContent(result)).replace(PTC_ERROR_PREFIX, "");
}

function getTextContent(result: PtcPartialResult | PtcToolResult): string {
	return result.content.find((content) => content.type === "text")?.text ?? "";
}
