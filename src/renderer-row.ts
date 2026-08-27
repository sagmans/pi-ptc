import type { AgentToolResult, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Spacer, Text } from "@earendil-works/pi-tui";

import {
	type PtcPersistedDispatch,
	type PtcPersistedRenderResult,
	sanitizeDisplayJson,
	sanitizeDisplayText,
} from "./dispatch-details.ts";
import type { NativeRenderContext, PtcImageServices, PtcRowView } from "./renderer-contract.ts";
import {
	createDiagnosticText,
	DEFAULT_RENDER_SHELL,
	DEFAULT_SHELL_PADDING_X,
	DEFAULT_SHELL_PADDING_Y,
	errorMessage,
	ROW_SPACING,
	renderRowFailure,
	sanitizeDiagnostic,
} from "./renderer-diagnostics.ts";
import { PtcImageCollection } from "./renderer-images.ts";

const RENDERER_INTERVAL_STATE_KEY = "interval";

type PtcDispatchRowInput = {
	cwd: string;
	definition: ToolDefinition | undefined;
	dispatch: PtcPersistedDispatch;
	imageServices: PtcImageServices;
	toolCallId: string;
	view: PtcRowView;
};

export class PtcDispatchRow implements Component {
	readonly id: number;
	private readonly callContainer: Container | Box;
	private readonly images: PtcImageCollection;
	private readonly input: PtcDispatchRowInput;
	private argsComplete: boolean;
	private callComponent: Component | undefined;
	private resultComponent: Component | undefined;
	private readonly rendererState: NativeRenderContext["state"] = {};
	private dispatch: PtcPersistedDispatch;
	private fingerprint = "";
	private mounted = true;
	private rebuilding = false;
	private renderFailure: string | undefined;
	private renderedTheme: Theme | undefined;
	private viewFingerprint = "";
	private view: PtcRowView;

	constructor(input: PtcDispatchRowInput) {
		this.input = input;
		this.id = input.dispatch.id;
		this.argsComplete = input.dispatch.status === "start";
		this.dispatch = input.dispatch;
		this.view = input.view;
		this.callContainer =
			(input.definition?.renderShell ?? DEFAULT_RENDER_SHELL) === "self"
				? new Container()
				: new Box(DEFAULT_SHELL_PADDING_X, DEFAULT_SHELL_PADDING_Y, this.getBackground());
		this.images = new PtcImageCollection({
			services: input.imageServices,
			getView: () => this.view,
			contain: (error) => this.contain(error),
			requestInvalidate: () => this.requestInvalidate(),
		});
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
		this.images.unmount();
		this.retireRendererTimer();
	}

	invalidate(): void {
		this.images.invalidateComponents();
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
			lines.push(...this.images.render(width));
			return lines;
		} catch (error) {
			this.contain(error);
			return renderRowFailure(errorMessage(error), width, this.view.theme);
		}
	}

	private invalidateRenderedChildren(): void {
		try {
			this.callContainer.invalidate();
			this.images.invalidateRenderedComponents();
		} catch (error) {
			this.contain(error);
		}
	}

	private rebuild(force: boolean, advanceGeneration = true): void {
		if (this.rebuilding) return;
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
		if (advanceGeneration) this.images.advanceGeneration();
		this.renderFailure = undefined;
		this.rebuilding = true;
		try {
			if (this.callContainer instanceof Box) this.callContainer.setBgFn(this.getBackground());
			this.callContainer.clear();
			this.callComponent = this.renderCall();
			this.callContainer.addChild(this.callComponent);
			const result = getDispatchResult(this.dispatch);
			this.resultComponent = result ? this.renderResult(result) : undefined;
			if (this.resultComponent) this.callContainer.addChild(this.resultComponent);
			this.images.refresh(result);
		} catch (error) {
			this.contain(error);
		} finally {
			if (this.dispatch.status !== "start") this.retireRendererTimer();
			this.rebuilding = false;
		}
	}

	private renderCall(): Component {
		const renderer = this.input.definition?.renderCall;
		if (!renderer || !hasCompleteNativeCallArguments(this.dispatch)) {
			return this.renderFallbackCall();
		}
		return renderer(
			sanitizeDisplayJson(this.dispatch.args) as never,
			this.view.theme,
			this.createRenderContext(this.callComponent),
		);
	}

	private renderFallbackCall(): Component {
		const args = this.dispatch.args;
		const path = isUnknownRecord(args) && typeof args.path === "string" ? ` ${args.path}` : "";
		return new Text(
			this.view.theme.fg("toolTitle", this.view.theme.bold(`${this.dispatch.name}${path}`)),
			0,
			0,
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
		return {
			args: sanitizeDisplayJson(this.dispatch.args),
			toolCallId: this.input.toolCallId,
			invalidate: () => {
				if (!this.mounted) return;
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
		this.images.clear();
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

function hasCompleteNativeCallArguments(dispatch: PtcPersistedDispatch): boolean {
	if (!isUnknownRecord(dispatch.args)) return false;
	if (dispatch.name === "write") return typeof dispatch.args.content === "string";
	if (dispatch.name === "edit") return Array.isArray(dispatch.args.edits);
	return true;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getDispatchResult(dispatch: PtcPersistedDispatch): PtcPersistedRenderResult | undefined {
	if (dispatch.result) return dispatch.result;
	if (dispatch.status === "start" && dispatch.preview === undefined) return undefined;
	return {
		content:
			dispatch.preview === undefined
				? []
				: [{ type: "text", text: sanitizeDisplayText(dispatch.preview) }],
		isError: dispatch.status === "err",
	};
}
