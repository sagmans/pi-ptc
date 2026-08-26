import {
	type Theme,
	ToolExecutionComponent,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	stripTerminalSequences,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";

import type { DispatchProgress } from "./bridge.ts";
import { isCoreToolName } from "./config.ts";
import { type JsonValue, snapshotJsonValue } from "./json.ts";
import type { PtcParams, PtcPartialResult, PtcToolResult } from "./transport.ts";

const EMPTY_VALUE_LABEL = "(empty)";
const EXECUTION_TOOL_NAME = "execution";
const NESTED_TOOL_CALL_SEPARATOR = ":dispatch:";
const PTC_ERROR_PREFIX = /^ptc failed \([^)]+\):\s*/;

const RENDER_DISPATCHES = new WeakMap<object, readonly DispatchProgress[]>();

type NativeDispatchRow = {
	component: ToolExecutionComponent;
	status: DispatchProgress["status"];
};

type PtcRendererState = {
	root?: Container;
	rows?: Map<number, NativeDispatchRow>;
	executionError?: ToolExecutionComponent;
	invalidationQueued?: boolean;
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
};

export function attachPtcRenderDispatches(
	details: object,
	dispatches: readonly DispatchProgress[],
): void {
	RENDER_DISPATCHES.set(details, [...dispatches]);
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
	_theme: Theme,
	context: PtcRenderContext,
): Container {
	const state = context.state;
	const root = state.root ?? new Container();
	const rows = state.rows ?? new Map<number, NativeDispatchRow>();
	state.root = root;
	state.rows = rows;

	for (const dispatch of getRenderDispatches(result.details)) {
		updateNativeRow(rows, dispatch, context);
	}

	root.clear();
	for (const [, row] of [...rows].sort(([left], [right]) => left - right)) {
		root.addChild(row.component);
	}

	const hasNestedFailure = [...rows.values()].some((row) => row.status === "err");
	if (context.isError && !hasNestedFailure) {
		const executionError = updateExecutionError(state.executionError, result, context);
		state.executionError = executionError;
		root.addChild(executionError);
	} else {
		state.executionError = undefined;
	}

	return root;
}

function updateNativeRow(
	rows: Map<number, NativeDispatchRow>,
	dispatch: DispatchProgress,
	context: PtcRenderContext,
): void {
	let row = rows.get(dispatch.id);
	if (!row) {
		const component = new ToolExecutionComponent(
			dispatch.name,
			`${context.toolCallId}${NESTED_TOOL_CALL_SEPARATOR}${dispatch.id}`,
			dispatch.args,
			{ showImages: context.showImages },
			undefined,
			createTuiAdapter(context),
			context.cwd,
		);
		component.markExecutionStarted();
		if (dispatch.status === "start") component.setArgsComplete();
		row = { component, status: dispatch.status };
		rows.set(dispatch.id, row);
	}

	row.status = dispatch.status;
	row.component.updateArgs(dispatch.args);
	row.component.setExpanded(context.expanded);
	row.component.setShowImages(context.showImages);
	if (dispatch.result !== undefined) {
		row.component.updateResult(dispatch.result, dispatch.status === "start");
	} else if (dispatch.status !== "start" || dispatch.preview !== undefined) {
		row.component.updateResult(
			{
				content:
					dispatch.preview === undefined
						? []
						: [{ type: "text", text: stripTerminalSequences(dispatch.preview) }],
				details: undefined,
				isError: dispatch.status === "err",
			},
			dispatch.status === "start",
		);
	}
}

function updateExecutionError(
	component: ToolExecutionComponent | undefined,
	result: PtcPartialResult | PtcToolResult,
	context: PtcRenderContext,
): ToolExecutionComponent {
	const executionError =
		component ??
		new ToolExecutionComponent(
			EXECUTION_TOOL_NAME,
			`${context.toolCallId}${NESTED_TOOL_CALL_SEPARATOR}${EXECUTION_TOOL_NAME}`,
			undefined,
			{ showImages: false },
			undefined,
			createTuiAdapter(context),
			context.cwd,
		);
	if (!component) executionError.markExecutionStarted();
	executionError.setExpanded(context.expanded);
	const raw = stripTerminalSequences(getTextContent(result)).replace(PTC_ERROR_PREFIX, "");
	executionError.updateResult(
		{
			content: [{ type: "text", text: raw || EMPTY_VALUE_LABEL }],
			details: undefined,
			isError: true,
		},
		false,
	);
	return executionError;
}

function createTuiAdapter(context: PtcRenderContext): TUI {
	return {
		requestRender: () => {
			if (context.state.invalidationQueued) return;
			context.state.invalidationQueued = true;
			queueMicrotask(() => {
				context.state.invalidationQueued = false;
				context.invalidate();
			});
		},
	} as TUI;
}

function getTextContent(result: PtcPartialResult | PtcToolResult): string {
	return result.content.find((content) => content.type === "text")?.text ?? "";
}

function getRenderDispatches(details: unknown): DispatchProgress[] {
	if (typeof details === "object" && details !== null) {
		const dispatches = RENDER_DISPATCHES.get(details);
		if (dispatches) return [...dispatches];
	}
	return getDispatches(details);
}

function getDispatches(details: unknown): DispatchProgress[] {
	if (!isRecord(details) || !Array.isArray(details.dispatches)) return [];
	const dispatches: DispatchProgress[] = [];
	for (const value of details.dispatches) {
		const dispatch = parseDispatch(value);
		if (dispatch) dispatches.push(dispatch);
	}
	return dispatches;
}

function parseDispatch(value: unknown): DispatchProgress | undefined {
	if (
		!isRecord(value) ||
		typeof value.id !== "number" ||
		!Number.isInteger(value.id) ||
		value.id < 1 ||
		typeof value.name !== "string" ||
		!isCoreToolName(value.name)
	) {
		return undefined;
	}
	if (value.status !== "start" && value.status !== "ok" && value.status !== "err") return undefined;
	try {
		const dispatch: DispatchProgress = {
			id: value.id,
			name: value.name,
			args: snapshotJsonValue(value.args),
			status: value.status,
		};
		if (typeof value.preview === "string") dispatch.preview = value.preview;
		return dispatch;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
