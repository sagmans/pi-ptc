import { createHash } from "node:crypto";

import {
	type AgentToolResult,
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
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	type ImageProtocol,
	Spacer,
	stripTerminalSequences,
	Text,
} from "@earendil-works/pi-tui";

import type { DispatchProgress } from "./bridge.ts";
import type { CoreToolName } from "./config.ts";
import {
	type PtcPersistedDispatch,
	type PtcPersistedRenderResult,
	parseDispatchDetails,
	sanitizeDisplayJson,
} from "./dispatch-details.ts";
import type { PtcParams, PtcPartialResult, PtcToolResult } from "./transport.ts";

const EMPTY_VALUE_LABEL = "(empty)";
const EXECUTION_TOOL_NAME = "execution";
const NESTED_TOOL_CALL_SEPARATOR = ":dispatch:";
const PTC_ERROR_PREFIX = /^ptc failed \([^)]+\):\s*/;
const DEFAULT_SHELL_PADDING_X = 1;
const DEFAULT_SHELL_PADDING_Y = 1;
const ROW_SPACING = 1;
const DIAGNOSTIC_MAX_CHARACTERS = 512;
const DIAGNOSTIC_MAX_LINES = 4;
const DEFAULT_RENDER_FAILURE_MESSAGE = "display failure";
const DEFAULT_RENDER_SHELL = "default";
const DISPLAY_DIAGNOSTIC_NAME = "display";
const IMAGE_HASH_ALGORITHM = "sha256";
const IMAGE_KEY_SEPARATOR = "\u0000";
const IMAGE_PNG_MIME_TYPE = "image/png";
const MINIMUM_IMAGE_WIDTH_CELLS = 1;
const RENDERER_INTERVAL_STATE_KEY = "interval";

export type PtcDefinitionRegistry = Partial<Record<CoreToolName, ToolDefinition>>;
export type PtcDefinitionFactory = (cwd: string) => PtcDefinitionRegistry;
export type PtcImageConverter = (
	data: string,
	mimeType: string,
) => Promise<{ data: string; mimeType: string } | null>;
export type PtcImageFactory = (
	data: string,
	mimeType: string,
	maxWidthCells: number,
	theme: Theme,
) => Component;
type NativeRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
type PtcImageServices = {
	convertImage: PtcImageConverter;
	createImage: PtcImageFactory;
	getImageProtocol(): ImageProtocol;
};
type PtcImageSource = {
	data: string;
	mimeType: string;
};
type PtcImageRecord = {
	component?: Component;
	componentWidth?: number;
	conversion?: Promise<{ data: string; mimeType: string } | null>;
	converted?: PtcImageSource;
	generation: number;
	key: string;
	source: PtcImageSource;
};

type PtcRendererState = {
	root?: SafePtcRoot;
};

type PtcRowView = {
	expanded: boolean;
	showImages: boolean;
	theme: Theme;
	invalidate(): void;
};

export type PtcRenderContext = {
	toolCallId: string;
	cwd: string;
	state: PtcRendererState;
	invalidate(): void;
	lastComponent: Component | undefined;
	expanded: boolean;
	showImages: boolean;
	isError: boolean;
	convertImage?: PtcImageConverter;
	createDefinitions?: PtcDefinitionFactory;
	createImage?: PtcImageFactory;
	getImageProtocol?: () => ImageProtocol;
};

export function attachPtcRenderDispatches(
	_details: object,
	_dispatches: readonly DispatchProgress[],
): void {}

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
	root.setView({
		expanded: context.expanded,
		showImages: context.showImages,
		theme,
		invalidate: context.invalidate,
	});
	for (const dispatch of details.dispatches) root.updateDispatch(dispatch);
	root.setCompatibilityError(details.compatibilityError);
	root.setExecutionError(
		context.isError ? (details.executionError ?? getOuterExecutionError(result)) : undefined,
	);
	return root;
}

class SafePtcRoot implements Component {
	readonly cwd: string;
	private readonly definitions: PtcDefinitionRegistry;
	private readonly imageServices: PtcImageServices;
	private readonly rows = new Map<number, PtcDispatchRow>();
	private readonly orderedRows: PtcDispatchRow[] = [];
	private compatibilityError: PtcDiagnosticRow | undefined;
	private containedFailure: string | undefined;
	private executionError: PtcDiagnosticRow | undefined;
	private view: PtcRowView;

	constructor(
		cwd: string,
		toolCallId: string,
		view: PtcRowView,
		definitions: PtcDefinitionRegistry,
		imageServices: PtcImageServices,
	) {
		this.cwd = cwd;
		this.toolCallId = toolCallId;
		this.view = view;
		this.definitions = definitions;
		this.imageServices = imageServices;
	}

	private readonly toolCallId: string;

	setView(view: PtcRowView): void {
		try {
			const visualStateChanged =
				this.view.expanded !== view.expanded ||
				this.view.showImages !== view.showImages ||
				this.view.theme !== view.theme;
			this.view.expanded = view.expanded;
			this.view.showImages = view.showImages;
			this.view.theme = view.theme;
			this.view.invalidate = view.invalidate;
			if (!visualStateChanged) return;
			for (const row of this.orderedRows) row.setView(this.view);
			this.compatibilityError?.setView(this.view);
			this.executionError?.setView(this.view);
		} catch (error) {
			this.contain(error);
		}
	}

	updateDispatch(dispatch: PtcPersistedDispatch): void {
		try {
			let row = this.rows.get(dispatch.id);
			if (!row) {
				row = new PtcDispatchRow({
					cwd: this.cwd,
					definition: this.definitions[dispatch.name],
					dispatch,
					imageServices: this.imageServices,
					toolCallId: `${this.toolCallId}${NESTED_TOOL_CALL_SEPARATOR}${dispatch.id}`,
					view: this.view,
				});
				this.rows.set(dispatch.id, row);
				const lastRow = this.orderedRows.at(-1);
				if (!lastRow || lastRow.id < dispatch.id) {
					this.orderedRows.push(row);
				} else {
					this.orderedRows.splice(findRowInsertionIndex(this.orderedRows, dispatch.id), 0, row);
				}
				return;
			}
			row.update(dispatch);
		} catch (error) {
			this.contain(error);
		}
	}

	setCompatibilityError(message: string | undefined): void {
		this.compatibilityError = this.updateDiagnostic(
			this.compatibilityError,
			DISPLAY_DIAGNOSTIC_NAME,
			message,
		);
	}

	setExecutionError(message: string | undefined): void {
		this.executionError = this.updateDiagnostic(this.executionError, EXECUTION_TOOL_NAME, message);
	}

	contain(error: unknown): void {
		this.containedFailure = sanitizeDiagnostic(errorMessage(error));
	}

	unmount(): void {
		for (const row of this.orderedRows) row.unmount();
	}

	invalidate(): void {
		try {
			for (const row of this.orderedRows) row.invalidate();
			this.compatibilityError?.invalidate();
			this.executionError?.invalidate();
		} catch (error) {
			this.contain(error);
		}
	}

	render(width: number): string[] {
		if (this.containedFailure) {
			return renderRootFailure(this.containedFailure, width, this.view.theme);
		}
		try {
			const lines: string[] = [];
			for (const row of this.orderedRows) lines.push(...row.render(width));
			if (this.compatibilityError) lines.push(...this.compatibilityError.render(width));
			if (this.executionError) lines.push(...this.executionError.render(width));
			return lines;
		} catch (error) {
			this.contain(error);
			return renderRootFailure(error, width, this.view.theme);
		}
	}

	private updateDiagnostic(
		current: PtcDiagnosticRow | undefined,
		label: string,
		message: string | undefined,
	): PtcDiagnosticRow | undefined {
		try {
			if (message === undefined) return undefined;
			const diagnostic = current ?? new PtcDiagnosticRow(label, this.view);
			diagnostic.setMessage(message);
			return diagnostic;
		} catch (error) {
			this.contain(error);
			return undefined;
		}
	}
}

class PtcDispatchRow implements Component {
	readonly id: number;
	private readonly input: {
		cwd: string;
		definition: ToolDefinition | undefined;
		dispatch: PtcPersistedDispatch;
		imageServices: PtcImageServices;
		toolCallId: string;
		view: PtcRowView;
	};
	private readonly callContainer: Container | Box;
	private argsComplete: boolean;
	private callComponent: Component | undefined;
	private resultComponent: Component | undefined;
	private readonly rendererState: NativeRenderContext["state"] = {};
	private dispatch: PtcPersistedDispatch;
	private fingerprint = "";
	private generation = 0;
	private imageCache = new Map<string, PtcImageRecord>();
	private imageOrder: PtcImageRecord[] = [];
	private mounted = true;
	private renderFailure: string | undefined;
	private renderedTheme: Theme | undefined;
	private viewFingerprint = "";
	private view: PtcRowView;

	constructor(input: {
		cwd: string;
		definition: ToolDefinition | undefined;
		dispatch: PtcPersistedDispatch;
		imageServices: PtcImageServices;
		toolCallId: string;
		view: PtcRowView;
	}) {
		this.input = input;
		this.id = input.dispatch.id;
		this.argsComplete = input.dispatch.status === "start";
		this.dispatch = input.dispatch;
		this.view = input.view;
		this.callContainer =
			(input.definition?.renderShell ?? DEFAULT_RENDER_SHELL) === "self"
				? new Container()
				: new Box(DEFAULT_SHELL_PADDING_X, DEFAULT_SHELL_PADDING_Y, this.getBackground());
		this.rebuild(true);
	}

	setView(view: PtcRowView): void {
		this.view = view;
		this.rebuild(false, false);
	}

	update(dispatch: PtcPersistedDispatch): void {
		this.dispatch = dispatch;
		if (dispatch.status === "start") this.argsComplete = true;
		this.rebuild(false);
	}

	unmount(): void {
		this.mounted = false;
		this.generation += 1;
		this.imageCache.clear();
		this.imageOrder = [];
		this.retireRendererTimer();
	}

	invalidate(): void {
		for (const image of this.imageOrder) {
			image.component = undefined;
			image.componentWidth = undefined;
		}
		this.rebuild(true, false);
		this.invalidateRenderedChildren();
	}

	render(width: number): string[] {
		if (this.renderFailure) {
			return renderRowFailure(this.renderFailure, width, this.view.theme);
		}
		try {
			const content = this.callContainer.render(width);
			const lines =
				content.length === 0 ? [] : [...new Spacer(ROW_SPACING).render(width), ...content];
			lines.push(...this.renderImages(width));
			return lines;
		} catch (error) {
			this.contain(error);
			return renderRowFailure(errorMessage(error), width, this.view.theme);
		}
	}

	private invalidateRenderedChildren(): void {
		try {
			this.callContainer.invalidate();
			for (const image of this.imageOrder) image.component?.invalidate();
		} catch (error) {
			this.contain(error);
		}
	}

	private rebuild(force: boolean, advanceGeneration = true): void {
		const fingerprint = JSON.stringify(this.dispatch);
		const viewFingerprint = `${this.view.expanded}:${this.view.showImages}`;
		if (
			!force &&
			fingerprint === this.fingerprint &&
			viewFingerprint === this.viewFingerprint &&
			this.renderedTheme === this.view.theme
		) {
			return;
		}
		this.fingerprint = fingerprint;
		this.viewFingerprint = viewFingerprint;
		this.renderedTheme = this.view.theme;
		if (advanceGeneration) this.generation += 1;
		this.renderFailure = undefined;
		try {
			if (this.callContainer instanceof Box) this.callContainer.setBgFn(this.getBackground());
			this.callContainer.clear();
			this.callComponent = this.renderCall();
			this.callContainer.addChild(this.callComponent);
			const result = getDispatchResult(this.dispatch);
			this.resultComponent = result ? this.renderResult(result) : undefined;
			if (this.resultComponent) this.callContainer.addChild(this.resultComponent);
			this.refreshImages(result);
		} catch (error) {
			this.contain(error);
		} finally {
			if (this.dispatch.status !== "start") this.retireRendererTimer();
		}
	}

	private renderCall(): Component {
		const renderer = this.input.definition?.renderCall;
		if (!renderer) {
			return new Text(
				this.view.theme.fg("toolTitle", this.view.theme.bold(this.dispatch.name)),
				0,
				0,
			);
		}
		return renderer(
			sanitizeDisplayJson(this.dispatch.args) as never,
			this.view.theme,
			this.createRenderContext(this.callComponent),
		);
	}

	private renderResult(result: PtcPersistedRenderResult): Component | undefined {
		const renderer = this.input.definition?.renderResult;
		if (!renderer) {
			const text = result.content.find((entry) => entry.type === "text")?.text;
			return text ? new Text(this.view.theme.fg("toolOutput", text), 0, 0) : undefined;
		}
		return renderer(
			result as unknown as AgentToolResult<unknown>,
			{
				expanded: this.view.expanded,
				isPartial: this.dispatch.status === "start",
			},
			this.view.theme,
			this.createRenderContext(this.resultComponent),
		);
	}

	private refreshImages(result: PtcPersistedRenderResult | undefined): void {
		const protocol = this.input.imageServices.getImageProtocol();
		if (!result || !this.view.showImages) {
			this.imageCache.clear();
			this.imageOrder = [];
			return;
		}
		const nextCache = new Map<string, PtcImageRecord>();
		const nextOrder: PtcImageRecord[] = [];
		for (const block of result.content) {
			if (block.type !== "image" || !block.data || !block.mimeType) continue;
			const key = imageContentKey(block.data, block.mimeType);
			let record = nextCache.get(key) ?? this.imageCache.get(key);
			if (!record) {
				record = {
					generation: this.generation,
					key,
					source: { data: block.data, mimeType: block.mimeType },
				};
			}
			record.generation = this.generation;
			nextCache.set(key, record);
			nextOrder.push(record);
			if (
				protocol === "kitty" &&
				record.source.mimeType !== IMAGE_PNG_MIME_TYPE &&
				!record.converted &&
				!record.conversion
			) {
				this.startImageConversion(record);
			}
		}
		this.imageCache = nextCache;
		this.imageOrder = nextOrder;
	}

	private startImageConversion(record: PtcImageRecord): void {
		let conversion: PtcImageRecord["conversion"];
		try {
			conversion = this.input.imageServices.convertImage(
				record.source.data,
				record.source.mimeType,
			);
			record.conversion = conversion;
		} catch (error) {
			this.contain(error);
			return;
		}
		void conversion.then(
			(converted) => {
				if (
					!converted ||
					!this.mounted ||
					record.generation !== this.generation ||
					this.imageCache.get(record.key) !== record
				) {
					return;
				}
				record.converted = converted;
				record.component = undefined;
				record.componentWidth = undefined;
				this.requestInvalidate();
			},
			(error) => {
				if (
					!this.mounted ||
					record.generation !== this.generation ||
					this.imageCache.get(record.key) !== record
				) {
					return;
				}
				this.contain(error);
				this.requestInvalidate();
			},
		);
	}

	private renderImages(width: number): string[] {
		if (!this.view.showImages) return [];
		const protocol = this.input.imageServices.getImageProtocol();
		const maxWidthCells = Math.max(MINIMUM_IMAGE_WIDTH_CELLS, Math.floor(width));
		const lines: string[] = [];
		for (const record of this.imageOrder) {
			const source = record.converted ?? record.source;
			if (protocol === "kitty" && source.mimeType !== IMAGE_PNG_MIME_TYPE) {
				continue;
			}
			if (!record.component || record.componentWidth !== maxWidthCells) {
				record.component = this.input.imageServices.createImage(
					source.data,
					source.mimeType,
					maxWidthCells,
					this.view.theme,
				);
				record.componentWidth = maxWidthCells;
			}
			lines.push(...new Spacer(ROW_SPACING).render(width));
			lines.push(...record.component.render(width));
		}
		return lines;
	}

	private requestInvalidate(): void {
		try {
			this.view.invalidate();
		} catch (error) {
			this.contain(error);
		}
	}

	private retireRendererTimer(): void {
		try {
			if (typeof this.rendererState !== "object" || this.rendererState === null) return;
			const interval = Reflect.get(this.rendererState, RENDERER_INTERVAL_STATE_KEY);
			if (interval === undefined) return;
			clearInterval(interval as NodeJS.Timeout);
			Reflect.set(this.rendererState, RENDERER_INTERVAL_STATE_KEY, undefined);
		} catch (error) {
			this.contain(error);
		}
	}

	private createRenderContext(lastComponent: Component | undefined): NativeRenderContext {
		const generation = this.generation;
		return {
			args: sanitizeDisplayJson(this.dispatch.args),
			toolCallId: this.input.toolCallId,
			invalidate: () => {
				if (generation !== this.generation) return;
				this.invalidateRenderedChildren();
				try {
					this.view.invalidate();
				} catch (error) {
					this.contain(error);
				}
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.input.cwd,
			executionStarted: true,
			argsComplete: this.argsComplete,
			isPartial: this.dispatch.status === "start",
			expanded: this.view.expanded,
			showImages: this.view.showImages,
			isError: this.dispatch.status === "err" || this.dispatch.result?.isError === true,
		};
	}

	private contain(error: unknown): void {
		this.renderFailure = sanitizeDiagnostic(errorMessage(error));
		this.imageCache.clear();
		this.imageOrder = [];
		try {
			this.callContainer.clear();
			this.callContainer.addChild(createDiagnosticText(this.renderFailure, this.view.theme));
		} catch {}
	}

	private getBackground(): (text: string) => string {
		const color =
			this.dispatch.status === "start"
				? "toolPendingBg"
				: this.dispatch.status === "err"
					? "toolErrorBg"
					: "toolSuccessBg";
		return (text) => this.view.theme.bg(color, text);
	}
}

class PtcDiagnosticRow implements Component {
	private readonly box: Box;
	private readonly label: string;
	private readonly text = new Text("", 0, 0);
	private message = EMPTY_VALUE_LABEL;
	private view: PtcRowView;

	constructor(label: string, view: PtcRowView) {
		this.label = label;
		this.view = view;
		this.box = new Box(DEFAULT_SHELL_PADDING_X, DEFAULT_SHELL_PADDING_Y, (text) =>
			safeBackground(this.view.theme, text),
		);
		this.box.addChild(this.text);
	}

	setView(view: PtcRowView): void {
		this.view = view;
		this.box.setBgFn((text) => safeBackground(this.view.theme, text));
		this.updateText();
	}

	setMessage(message: string): void {
		this.message = sanitizeDiagnostic(message) || EMPTY_VALUE_LABEL;
		this.updateText();
	}

	invalidate(): void {
		try {
			this.updateText();
			this.box.invalidate();
		} catch {}
	}

	render(width: number): string[] {
		try {
			return [...new Spacer(ROW_SPACING).render(width), ...this.box.render(width)];
		} catch {
			return ["", `${this.label}: ${this.message}`];
		}
	}

	private updateText(): void {
		const title = safeForeground(
			this.view.theme,
			"toolTitle",
			safeBold(this.view.theme, this.label),
		);
		this.text.setText(`${title}\n${safeForeground(this.view.theme, "error", this.message)}`);
	}
}

function findRowInsertionIndex(rows: readonly PtcDispatchRow[], id: number): number {
	let low = 0;
	let high = rows.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if ((rows[middle]?.id ?? id) < id) low = middle + 1;
		else high = middle;
	}
	return low;
}

function getRoot(context: PtcRenderContext, theme: Theme): SafePtcRoot {
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

function imageContentKey(data: string, mimeType: string): string {
	return createHash(IMAGE_HASH_ALGORITHM)
		.update(mimeType)
		.update(IMAGE_KEY_SEPARATOR)
		.update(data)
		.digest("hex");
}

function getDispatchResult(dispatch: PtcPersistedDispatch): PtcPersistedRenderResult | undefined {
	if (dispatch.result) return dispatch.result;
	if (dispatch.status === "start" && dispatch.preview === undefined) return undefined;
	return {
		content:
			dispatch.preview === undefined
				? []
				: [{ type: "text", text: stripTerminalSequences(dispatch.preview) }],
		isError: dispatch.status === "err",
	};
}

function getOuterExecutionError(result: PtcPartialResult | PtcToolResult): string {
	return stripTerminalSequences(getTextContent(result)).replace(PTC_ERROR_PREFIX, "");
}

function getTextContent(result: PtcPartialResult | PtcToolResult): string {
	return result.content.find((content) => content.type === "text")?.text ?? "";
}

function renderRootFailure(error: unknown, width: number, theme: Theme): string[] {
	const diagnostic = new PtcDiagnosticRow(EXECUTION_TOOL_NAME, {
		expanded: false,
		showImages: false,
		theme,
		invalidate: () => undefined,
	});
	diagnostic.setMessage(errorMessage(error));
	return diagnostic.render(width);
}

function renderRowFailure(message: string, width: number, theme: Theme): string[] {
	try {
		const box = new Box(DEFAULT_SHELL_PADDING_X, DEFAULT_SHELL_PADDING_Y, (text) =>
			safeBackground(theme, text),
		);
		box.addChild(createDiagnosticText(message, theme));
		return [...new Spacer(ROW_SPACING).render(width), ...box.render(width)];
	} catch {
		return ["", `${EXECUTION_TOOL_NAME}: ${sanitizeDiagnostic(message)}`];
	}
}

function createDiagnosticText(message: string, theme: Theme): Text {
	const title = safeForeground(theme, "toolTitle", safeBold(theme, EXECUTION_TOOL_NAME));
	return new Text(`${title}\n${safeForeground(theme, "error", sanitizeDiagnostic(message))}`, 0, 0);
}

function errorMessage(error: unknown): string {
	try {
		return error instanceof Error ? error.message : String(error);
	} catch {
		return DEFAULT_RENDER_FAILURE_MESSAGE;
	}
}

function sanitizeDiagnostic(message: string): string {
	return stripTerminalSequences(message)
		.slice(0, DIAGNOSTIC_MAX_CHARACTERS)
		.split(/\r?\n/)
		.slice(0, DIAGNOSTIC_MAX_LINES)
		.join("\n");
}

function safeBold(theme: Theme, text: string): string {
	try {
		return theme.bold(text);
	} catch {
		return text;
	}
}

function safeForeground(theme: Theme, color: Parameters<Theme["fg"]>[0], text: string): string {
	try {
		return theme.fg(color, text);
	} catch {
		return text;
	}
}

function safeBackground(theme: Theme, text: string): string {
	try {
		return theme.bg("toolErrorBg", text);
	} catch {
		return text;
	}
}
