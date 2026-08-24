// Narrow Pi host types so tests can load the installer without a live session.

export type ExtensionAPI = {
	registerTool(definition: unknown): void;
	registerCommand(
		name: string,
		definition: {
			description?: string;
			handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
		},
	): void;
	on(event: string, handler: (...args: unknown[]) => unknown): void;
	setActiveTools(names: string[]): void;
	getActiveTools(): string[];
	getAllTools(): ReadonlyArray<{ name: string }>;
	appendEntry(customType: string, data?: unknown): void;
	events: {
		emit(name: string, payload: unknown): void;
	};
};

export type ExtensionUi = {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
};

export type ExtensionContext = {
	cwd: string;
	ui: ExtensionUi;
	isProjectTrusted(): boolean;
	signal?: AbortSignal;
};
