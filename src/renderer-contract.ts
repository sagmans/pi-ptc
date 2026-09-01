import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component, ImageProtocol } from "@earendil-works/pi-tui";

import type { PtcPersistedDispatch, PtcPersistedRenderResult } from "./dispatch-details.ts";
import type { ToolCatalogEntry } from "./tool-catalog.ts";

export type PtcRenderDefinition = Pick<
	ToolDefinition,
	"renderCall" | "renderResult" | "renderShell"
>;
export type PtcDefinitionRegistry = ReadonlyMap<string, PtcRenderDefinition>;
export type PtcDefinitionFactory = (cwd: string) => PtcDefinitionRegistry;
export type PtcDefinitionProvider = (cwd: string) => readonly ToolCatalogEntry[];
export type PtcLiveRenderAttachment = {
	readonly args: unknown;
	readonly isCurrent: () => boolean;
	readonly displayResult?: PtcPersistedRenderResult;
	readonly hasResult: boolean;
	readonly result?: unknown;
};
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
	updateDispatch(dispatch: PtcPersistedDispatch, attachment?: PtcLiveRenderAttachment): void;
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
