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

import { isCoreToolName, SHIPPED_PTC_CONFIG } from "./config.ts";
import type { DispatchProgress, DispatchRenderResult } from "./dispatch-contract.ts";
import {
	parseDispatchDetails,
	projectLiveDisplayArguments,
	sanitizeDisplayText,
} from "./dispatch-details.ts";
import {
	getLiveDispatchArguments,
	getLiveDispatchResult,
	getLiveDispatchRetentionResult,
} from "./dispatch-live.ts";
import { projectRenderResult } from "./dispatch-retention.ts";
import type {
	PtcDefinitionProvider,
	PtcDefinitionRegistry,
	PtcLiveRenderAttachment,
	PtcRenderContext,
	PtcRenderDefinition,
	PtcRendererRoot,
	PtcRowView,
} from "./renderer-contract.ts";
import { safeForeground } from "./renderer-diagnostics.ts";
import { SafePtcRoot } from "./renderer-root.ts";
import type { ToolCatalogEntry } from "./tool-catalog.ts";
import type { PtcParams, PtcPartialResult, PtcToolResult } from "./transport.ts";

export type {
	PtcDefinitionFactory,
	PtcDefinitionProvider,
	PtcDefinitionRegistry,
	PtcImageConverter,
	PtcImageFactory,
	PtcRenderContext,
} from "./renderer-contract.ts";

const PTC_ERROR_PREFIX = /^ptc failed \([^)]+\):\s*/;
const MAX_RENDER_DEFINITION_PROTOTYPE_DEPTH = 16;
const RENDER_DEFINITION_KEYS = ["renderCall", "renderResult", "renderShell"] as const;
const liveRenderAttachments = new WeakMap<object, ReadonlyMap<number, PtcLiveRenderAttachment>>();

export function attachPtcRenderDispatches(
	details: object,
	dispatches: readonly DispatchProgress[],
): void {
	liveRenderAttachments.set(
		details,
		new Map(dispatches.map((dispatch) => [dispatch.id, createLiveAttachment(dispatch)])),
	);
}

export function createPtcDefinitionRegistry(
	catalog: readonly ToolCatalogEntry[],
): PtcDefinitionRegistry {
	const definitions = new Map<string, PtcRenderDefinition>();
	for (const entry of catalog) {
		const definition = projectRenderDefinition(entry.definition);
		if (definition) definitions.set(entry.name, definition);
	}
	return definitions;
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
	definitionProvider?: PtcDefinitionProvider,
): Component {
	const root = getRoot(context, theme, definitionProvider);
	const details = parseDispatchDetails(result.details);
	const attachments =
		typeof result.details === "object" && result.details !== null
			? liveRenderAttachments.get(result.details)
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

function createLiveAttachment(dispatch: DispatchProgress): PtcLiveRenderAttachment {
	const core = isCoreToolName(dispatch.name);
	const liveArguments = getLiveDispatchArguments(dispatch)?.arguments ?? dispatch.args;
	const result = core ? undefined : getLiveDispatchResult(dispatch);
	const args = core ? projectLiveDisplayArguments(dispatch.name, liveArguments) : liveArguments;
	if (core) return { args, hasResult: false };
	let retentionResult: DispatchRenderResult | undefined;
	let projectedResult: unknown;
	try {
		retentionResult = getLiveDispatchRetentionResult(dispatch)?.result ?? dispatch.result;
		projectedResult = result ? result.result : dispatch.result;
	} catch {
		return { args, hasResult: false };
	}
	const displayResult = createLiveDisplayResult(retentionResult);
	return projectedResult === undefined
		? { args, displayResult, hasResult: false }
		: { args, displayResult, hasResult: true, result: projectedResult };
}

function createLiveDisplayResult(
	result: DispatchRenderResult | undefined,
): PtcLiveRenderAttachment["displayResult"] {
	if (!result) return undefined;
	let content: unknown;
	let isError: unknown;
	try {
		content = Reflect.get(result, "content");
		isError = Reflect.get(result, "isError");
	} catch {
		return undefined;
	}
	const projection = projectRenderResult(
		{ content, isError: isError === true },
		SHIPPED_PTC_CONFIG.maxRenderDetailsBytes,
	);
	return projection.kind === "accepted" ? projection.result : undefined;
}

function getRoot(
	context: PtcRenderContext,
	theme: Theme,
	definitionProvider: PtcDefinitionProvider | undefined,
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

function createNativeDefinitions(cwd: string): Map<string, PtcRenderDefinition> {
	return new Map([
		["bash", createBashToolDefinition(cwd) as unknown as ToolDefinition],
		["edit", createEditToolDefinition(cwd) as unknown as ToolDefinition],
		["find", createFindToolDefinition(cwd) as unknown as ToolDefinition],
		["grep", createGrepToolDefinition(cwd) as unknown as ToolDefinition],
		["ls", createLsToolDefinition(cwd) as unknown as ToolDefinition],
		["read", createReadToolDefinition(cwd) as unknown as ToolDefinition],
		["write", createWriteToolDefinition(cwd) as unknown as ToolDefinition],
	]);
}

function mergeDefinitions(
	target: Map<string, PtcRenderDefinition>,
	source: PtcDefinitionRegistry,
	overrideExisting: boolean,
): void {
	for (const [name, rawDefinition] of source) {
		const definition = projectRenderDefinition(rawDefinition);
		if (!definition) continue;
		const existing = target.get(name);
		if (existing && !overrideExisting) continue;
		target.set(name, existing ? { ...existing, ...definition } : definition);
	}
}

function projectRenderDefinition(value: unknown): PtcRenderDefinition | undefined {
	if (!isObjectLike(value)) return undefined;
	try {
		const values = readRenderDataValues(value);
		if (!values) return undefined;
		const definition: PtcRenderDefinition = {};
		if (typeof values.renderCall === "function") {
			definition.renderCall = values.renderCall as NonNullable<ToolDefinition["renderCall"]>;
		}
		if (typeof values.renderResult === "function") {
			definition.renderResult = values.renderResult as NonNullable<ToolDefinition["renderResult"]>;
		}
		if (values.renderShell === "default" || values.renderShell === "self") {
			definition.renderShell = values.renderShell;
		}
		return Object.keys(definition).length === 0 ? undefined : definition;
	} catch {
		return undefined;
	}
}

function readRenderDataValues(
	value: object,
): Partial<Record<(typeof RENDER_DEFINITION_KEYS)[number], unknown>> | undefined {
	const values: Partial<Record<(typeof RENDER_DEFINITION_KEYS)[number], unknown>> = {};
	const unresolved = new Set<string>(RENDER_DEFINITION_KEYS);
	const visited = new Set<object>();
	let current: object | null = value;
	for (let depth = 0; current !== null; depth += 1) {
		if (depth > MAX_RENDER_DEFINITION_PROTOTYPE_DEPTH || visited.has(current)) return undefined;
		visited.add(current);
		for (const key of RENDER_DEFINITION_KEYS) {
			if (!unresolved.has(key)) continue;
			const descriptor = Object.getOwnPropertyDescriptor(current, key);
			if (!descriptor) continue;
			unresolved.delete(key);
			if (Object.hasOwn(descriptor, "value")) values[key] = descriptor.value;
		}
		if (unresolved.size === 0) return values;
		if (depth === MAX_RENDER_DEFINITION_PROTOTYPE_DEPTH) return undefined;
		current = Object.getPrototypeOf(current);
	}
	return values;
}

function isObjectLike(value: unknown): value is object {
	return (typeof value === "object" && value !== null) || typeof value === "function";
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
