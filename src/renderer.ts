import {
	convertToPng,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getCapabilities,
	Image,
	type ImageProtocol,
	Text,
} from "@earendil-works/pi-tui";
import { parseDispatchDetails, sanitizeDisplayText } from "./dispatch-details.ts";
import type { PtcParams, PtcPartialResult, PtcToolResult } from "./ptc-tool-contract.ts";
import type {
	PtcDefinitionProvider,
	PtcDefinitionRegistry,
	PtcRenderContext,
	PtcRendererRoot,
	PtcRowView,
} from "./renderer-contract.ts";
import {
	createNativeDefinitions,
	createPtcDefinitionRegistry,
	mergeDefinitions,
} from "./renderer-definitions.ts";
import { safeForeground } from "./renderer-diagnostics.ts";
import type { RawRenderStore } from "./renderer-raw-store.ts";
import { SafePtcRoot } from "./renderer-root.ts";

export type {
	PtcDefinitionFactory,
	PtcDefinitionProvider,
	PtcDefinitionRegistry,
	PtcImageConverter,
	PtcImageFactory,
	PtcRenderContext,
} from "./renderer-contract.ts";
export { createPtcDefinitionRegistry } from "./renderer-definitions.ts";
export { attachPtcRenderDispatches } from "./renderer-raw-store.ts";

export const PTC_ERROR_PREFIX = /^ptc failed \([^)]+\):\s*/;

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
	definitionProvider?: PtcDefinitionProvider,
	executionDefinitions?: PtcDefinitionRegistry,
	rawRenderStore?: RawRenderStore,
): Component {
	const root = getRoot(context, theme, definitionProvider, executionDefinitions);
	const details = parseDispatchDetails(result.details);
	const attachments =
		typeof result.details === "object" && result.details !== null
			? rawRenderStore?.claim(result.details)
			: undefined;
	root.setView({
		expanded: context.expanded,
		showImages: context.showImages,
		theme,
		invalidate: context.invalidate,
	});
	for (const dispatch of details.dispatches) {
		root.updateDispatch(dispatch, attachments?.get(dispatch.id));
	}
	root.setCompatibilityError(details.compatibilityError);
	root.setExecutionError(
		context.isError ? (details.executionError ?? getOuterExecutionError(result)) : undefined,
	);
	return root;
}

export function getRoot(
	context: PtcRenderContext,
	theme: Theme,
	definitionProvider: PtcDefinitionProvider | undefined,
	executionDefinitions: PtcDefinitionRegistry | undefined,
): PtcRendererRoot {
	const existing = context.state.root;
	if (existing?.cwd === context.cwd) return existing;
	existing?.unmount();
	const view: PtcRowView = {
		expanded: context.expanded,
		showImages: context.showImages,
		theme,
		invalidate: context.invalidate,
	};
	const definitions = createNativeDefinitions(context.cwd);
	let constructionFailure: unknown;
	try {
		if (context.createDefinitions) {
			mergeDefinitions(definitions, context.createDefinitions(context.cwd), true);
		} else if (executionDefinitions) {
			mergeDefinitions(definitions, executionDefinitions, false);
		} else if (definitionProvider) {
			mergeDefinitions(
				definitions,
				createPtcDefinitionRegistry(definitionProvider(context.cwd)),
				false,
			);
		}
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

export function createNativeImage(
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

export function getNativeImageProtocol(): ImageProtocol {
	return getCapabilities().images;
}

export function getOuterExecutionError(result: PtcPartialResult | PtcToolResult): string {
	return sanitizeDisplayText(getTextContent(result)).replace(PTC_ERROR_PREFIX, "");
}

export function getTextContent(result: PtcPartialResult | PtcToolResult): string {
	return result.content.find((content) => content.type === "text")?.text ?? "";
}
