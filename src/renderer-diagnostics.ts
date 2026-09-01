import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Spacer, Text } from "@earendil-works/pi-tui";

import { sanitizeDisplayText } from "./dispatch-details.ts";
import type { PtcRowView } from "./renderer-contract.ts";

export const EXECUTION_TOOL_NAME = "execution";
export const DISPLAY_DIAGNOSTIC_NAME = "display";
export const DEFAULT_RENDER_SHELL = "default";
export const DEFAULT_SHELL_PADDING_X = 1;
export const DEFAULT_SHELL_PADDING_Y = 1;
export const ROW_SPACING = 1;
const EMPTY_VALUE_LABEL = "(empty)";
const DIAGNOSTIC_MAX_CHARACTERS = 512;
const DIAGNOSTIC_MAX_LINES = 4;
const DEFAULT_RENDER_FAILURE_MESSAGE = "display failure";

export class PtcDiagnosticRow implements Component {
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

export function renderRootFailure(error: unknown, width: number, theme: Theme): string[] {
	const diagnostic = new PtcDiagnosticRow(EXECUTION_TOOL_NAME, {
		expanded: false,
		showImages: false,
		theme,
		invalidate: () => undefined,
	});
	diagnostic.setMessage(errorMessage(error));
	return diagnostic.render(width);
}

export function renderRowFailure(message: string, width: number, theme: Theme): string[] {
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

export function createDiagnosticText(message: string, theme: Theme): Text {
	const title = safeForeground(theme, "toolTitle", safeBold(theme, EXECUTION_TOOL_NAME));
	return new Text(`${title}\n${safeForeground(theme, "error", sanitizeDiagnostic(message))}`, 0, 0);
}

export function errorMessage(error: unknown): string {
	try {
		return error instanceof Error ? error.message : String(error);
	} catch {
		return DEFAULT_RENDER_FAILURE_MESSAGE;
	}
}

export function sanitizeDiagnostic(message: string): string {
	return sanitizeDisplayText(message)
		.slice(0, DIAGNOSTIC_MAX_CHARACTERS)
		.split(/\r?\n/)
		.slice(0, DIAGNOSTIC_MAX_LINES)
		.join("\n");
}

export function safeBold(theme: Theme, text: string): string {
	try {
		return theme.bold(text);
	} catch {
		return text;
	}
}

export function safeForeground(
	theme: Theme,
	color: Parameters<Theme["fg"]>[0],
	text: string,
): string {
	try {
		return theme.fg(color, text);
	} catch {
		return text;
	}
}

export function safeBackground(theme: Theme, text: string): string {
	try {
		return theme.bg("toolErrorBg", text);
	} catch {
		return text;
	}
}
