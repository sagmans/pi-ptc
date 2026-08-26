import {
	type AgentToolResult,
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
const DEFAULT_RENDER_SHELL = "default";

export type PtcDefinitionRegistry = Partial<Record<CoreToolName, ToolDefinition>>;
export type PtcDefinitionFactory = (cwd: string) => PtcDefinitionRegistry;
type NativeRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

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
	createDefinitions?: PtcDefinitionFactory;
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
	root.setExecutionError(
		context.isError ? (details.executionError ?? getOuterExecutionError(result)) : undefined,
	);
	return root;
}

class SafePtcRoot implements Component {
	readonly cwd: string;
	private readonly definitions: PtcDefinitionRegistry;
	private readonly rows = new Map<number, PtcDispatchRow>();
	private readonly orderedRows: PtcDispatchRow[] = [];
	private executionError: PtcExecutionErrorRow | undefined;
	private view: PtcRowView;

	constructor(
		cwd: string,
		toolCallId: string,
		view: PtcRowView,
		definitions: PtcDefinitionRegistry,
	) {
		this.cwd = cwd;
		this.toolCallId = toolCallId;
		this.view = view;
		this.definitions = definitions;
	}

	private readonly toolCallId: string;

	setView(view: PtcRowView): void {
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
		this.executionError?.setView(this.view);
	}

	updateDispatch(dispatch: PtcPersistedDispatch): void {
		let row = this.rows.get(dispatch.id);
		if (!row) {
			row = new PtcDispatchRow({
				cwd: this.cwd,
				definition: this.definitions[dispatch.name],
				dispatch,
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
	}

	setExecutionError(message: string | undefined): void {
		if (message === undefined) {
			this.executionError = undefined;
			return;
		}
		if (!this.executionError) {
			this.executionError = new PtcExecutionErrorRow(this.view);
		}
		this.executionError.setMessage(message);
	}

	invalidate(): void {
		for (const row of this.orderedRows) row.invalidate();
		this.executionError?.invalidate();
	}

	render(width: number): string[] {
		try {
			const lines: string[] = [];
			for (const row of this.orderedRows) lines.push(...row.render(width));
			if (this.executionError) lines.push(...this.executionError.render(width));
			return lines;
		} catch (error) {
			return renderRootFailure(error, width, this.view.theme);
		}
	}
}

class PtcDispatchRow implements Component {
	readonly id: number;
	private readonly input: {
		cwd: string;
		definition: ToolDefinition | undefined;
		dispatch: PtcPersistedDispatch;
		toolCallId: string;
		view: PtcRowView;
	};
	private readonly callContainer: Container | Box;
	private callComponent: Component | undefined;
	private resultComponent: Component | undefined;
	private readonly rendererState: NativeRenderContext["state"] = {};
	private dispatch: PtcPersistedDispatch;
	private fingerprint = "";
	private generation = 0;
	private renderFailure: string | undefined;
	private renderedTheme: Theme | undefined;
	private viewFingerprint = "";
	private view: PtcRowView;

	constructor(input: {
		cwd: string;
		definition: ToolDefinition | undefined;
		dispatch: PtcPersistedDispatch;
		toolCallId: string;
		view: PtcRowView;
	}) {
		this.input = input;
		this.id = input.dispatch.id;
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
		this.rebuild(false);
	}

	update(dispatch: PtcPersistedDispatch): void {
		this.dispatch = dispatch;
		this.rebuild(false);
	}

	invalidate(): void {
		this.callContainer.invalidate();
		this.callComponent?.invalidate();
		this.resultComponent?.invalidate();
	}

	render(width: number): string[] {
		if (this.renderFailure) {
			return renderRowFailure(this.renderFailure, width, this.view.theme);
		}
		const content = this.callContainer.render(width);
		return content.length === 0 ? [] : [...new Spacer(ROW_SPACING).render(width), ...content];
	}

	private rebuild(force: boolean): void {
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
		this.generation += 1;
		this.renderFailure = undefined;
		try {
			if (this.callContainer instanceof Box) this.callContainer.setBgFn(this.getBackground());
			this.callContainer.clear();
			this.callComponent = this.renderCall();
			this.callContainer.addChild(this.callComponent);
			const result = getDispatchResult(this.dispatch);
			this.resultComponent = result ? this.renderResult(result) : undefined;
			if (this.resultComponent) this.callContainer.addChild(this.resultComponent);
		} catch (error) {
			this.renderFailure = errorMessage(error);
			this.callContainer.clear();
			this.callContainer.addChild(createDiagnosticText(this.renderFailure, this.view.theme));
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

	private createRenderContext(lastComponent: Component | undefined): NativeRenderContext {
		const generation = this.generation;
		return {
			args: sanitizeDisplayJson(this.dispatch.args),
			toolCallId: this.input.toolCallId,
			invalidate: () => {
				if (generation !== this.generation) return;
				this.invalidate();
				this.view.invalidate();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.input.cwd,
			executionStarted: true,
			argsComplete: true,
			isPartial: this.dispatch.status === "start",
			expanded: this.view.expanded,
			showImages: this.view.showImages,
			isError: this.dispatch.status === "err" || this.dispatch.result?.isError === true,
		};
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

class PtcExecutionErrorRow implements Component {
	private readonly box: Box;
	private readonly text = new Text("", 0, 0);
	private message = EMPTY_VALUE_LABEL;
	private view: PtcRowView;

	constructor(view: PtcRowView) {
		this.view = view;
		this.box = new Box(DEFAULT_SHELL_PADDING_X, DEFAULT_SHELL_PADDING_Y, (text) =>
			this.view.theme.bg("toolErrorBg", text),
		);
		this.box.addChild(this.text);
	}

	setView(view: PtcRowView): void {
		this.view = view;
		this.box.setBgFn((text) => this.view.theme.bg("toolErrorBg", text));
		this.updateText();
	}

	setMessage(message: string): void {
		this.message = sanitizeDiagnostic(message) || EMPTY_VALUE_LABEL;
		this.updateText();
	}

	invalidate(): void {
		this.box.invalidate();
	}

	render(width: number): string[] {
		return [...new Spacer(ROW_SPACING).render(width), ...this.box.render(width)];
	}

	private updateText(): void {
		this.text.setText(
			`${this.view.theme.fg("toolTitle", this.view.theme.bold(EXECUTION_TOOL_NAME))}\n${this.view.theme.fg("error", this.message)}`,
		);
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
	const view: PtcRowView = {
		expanded: context.expanded,
		showImages: context.showImages,
		theme,
		invalidate: context.invalidate,
	};
	const root = new SafePtcRoot(
		context.cwd,
		context.toolCallId,
		view,
		(context.createDefinitions ?? createNativeDefinitions)(context.cwd),
	);
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
	const diagnostic = new PtcExecutionErrorRow({
		expanded: false,
		showImages: false,
		theme,
		invalidate: () => undefined,
	});
	diagnostic.setMessage(errorMessage(error));
	return diagnostic.render(width);
}

function renderRowFailure(message: string, width: number, theme: Theme): string[] {
	const box = new Box(DEFAULT_SHELL_PADDING_X, DEFAULT_SHELL_PADDING_Y, (text) =>
		theme.bg("toolErrorBg", text),
	);
	box.addChild(createDiagnosticText(message, theme));
	return [...new Spacer(ROW_SPACING).render(width), ...box.render(width)];
}

function createDiagnosticText(message: string, theme: Theme): Text {
	return new Text(
		`${theme.fg("toolTitle", theme.bold(EXECUTION_TOOL_NAME))}\n${theme.fg("error", sanitizeDiagnostic(message))}`,
		0,
		0,
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sanitizeDiagnostic(message: string): string {
	return stripTerminalSequences(message).slice(0, DIAGNOSTIC_MAX_CHARACTERS);
}
