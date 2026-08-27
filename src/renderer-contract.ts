import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component, ImageProtocol } from "@earendil-works/pi-tui";

import type { CoreToolName } from "./config.ts";
import type { PtcPersistedDispatch } from "./dispatch-details.ts";

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
export type NativeRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
export type PtcImageServices = {
	convertImage: PtcImageConverter;
	createImage: PtcImageFactory;
	getImageProtocol(): ImageProtocol;
};
export type PtcRowView = {
	expanded: boolean;
	showImages: boolean;
	theme: Theme;
	invalidate(): void;
};
export type PtcRendererRoot = Component & {
	readonly cwd: string;
	setView(view: PtcRowView): void;
	updateDispatch(dispatch: PtcPersistedDispatch): void;
	setCompatibilityError(message: string | undefined): void;
	setExecutionError(message: string | undefined): void;
	contain(error: unknown): void;
	unmount(): void;
};
export type PtcRendererState = {
	root?: PtcRendererRoot;
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
