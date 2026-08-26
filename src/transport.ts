// One model-visible tool. Intermediate binding values stay off the transcript.

import { Type } from "typebox";

import { type DispatchProgress, formatDispatchLine } from "./bridge.ts";
import {
	EMPTY_DESCRIPTION_MESSAGE,
	OUTER_OVERFLOW_BYTES_MESSAGE,
	OUTER_OVERFLOW_LINES_MESSAGE,
	SHIPPED_PTC_CONFIG,
	TRANSPORT_NAME,
	TRUST_COPY,
} from "./config.ts";
import {
	createDeltaDetailsFromProjection,
	createSnapshotDetailsFromProjections,
	type PtcDispatchDetails,
	type PtcDispatchProjection,
	projectDispatchForRetention,
} from "./dispatch-details.ts";
import type { JsonValue } from "./json.ts";
import { renderPtcCall, renderPtcResult } from "./renderer.ts";
import { type BindingFn, type CodeRunResult, runCode } from "./runtime.ts";

export type PtcParams = {
	code: string;
	description: string;
};

export type PtcExecuteContext = {
	cwd: string;
	signal?: AbortSignal;
	reportDispatch?: (progress: DispatchProgress) => void;
};

export type PtcPartialResult = {
	content: Array<{ type: "text"; text: string }>;
	details: PtcDispatchDetails;
};

export type PtcOnUpdate = (partial: PtcPartialResult) => void;

export type PtcToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: PtcDispatchDetails;
};

const RENDER_BUDGET_OMISSION = "budget";

export type FailureDetailsStore = {
	remember(toolCallId: string, details: PtcDispatchDetails): void;
	consume(toolCallId: string): PtcDispatchDetails | undefined;
	clear(): void;
};

export function createFailureDetailsStore(): FailureDetailsStore {
	const entries = new Map<string, PtcDispatchDetails>();
	return {
		remember(toolCallId, details) {
			entries.set(toolCallId, details);
		},
		consume(toolCallId) {
			const details = entries.get(toolCallId);
			entries.delete(toolCallId);
			return details;
		},
		clear() {
			entries.clear();
		},
	};
}

const PTC_PARAMETERS = Type.Object({
	code: Type.String({
		description: "Body of an async function. Top-level await and return are legal.",
	}),
	description: Type.String({
		description: "Short UI label for this program, in active voice.",
	}),
});

export function createPtcTool(options: {
	timeoutMs: number;
	maxDispatches: number;
	maxRenderDetailsBytes?: number;
	maxOutputBytes: number;
	maxOutputLines: number;
	createBindings: (ctx: PtcExecuteContext) => Record<string, BindingFn>;
	failureDetails?: FailureDetailsStore;
	run?: typeof runCode;
}) {
	const run = options.run ?? runCode;
	const failureDetails = options.failureDetails ?? createFailureDetailsStore();
	const maxRenderDetailsBytes =
		options.maxRenderDetailsBytes ?? SHIPPED_PTC_CONFIG.maxRenderDetailsBytes;
	return {
		name: TRANSPORT_NAME,
		label: "PTC",
		description: `Execute a TypeScript program against core tools. ${TRUST_COPY}`,
		promptSnippet: "Run a program against core tools",
		parameters: PTC_PARAMETERS,
		renderShell: "self" as const,
		renderCall: renderPtcCall,
		renderResult: renderPtcResult,
		async execute(
			toolCallId: string,
			params: PtcParams,
			signal: AbortSignal | undefined,
			onUpdate: PtcOnUpdate | undefined,
			ctx: PtcExecuteContext,
		): Promise<PtcToolResult> {
			if (params.description.trim().length === 0) {
				throw new Error(EMPTY_DESCRIPTION_MESSAGE);
			}
			const abortSignal = signal ?? ctx.signal;
			const dispatches = new Map<number, PtcDispatchProjection>();
			let retainedRenderBytes = 0;
			let renderBudgetExhausted = false;
			const reportDispatch = (progress: DispatchProgress) => {
				const previous = dispatches.get(progress.id);
				if (previous) retainedRenderBytes -= previous.renderBytes;
				const projection = projectDispatchForRetention(
					progress,
					Math.max(0, maxRenderDetailsBytes - retainedRenderBytes),
					renderBudgetExhausted,
				);
				retainedRenderBytes += projection.renderBytes;
				if (projection.dispatch.renderOmitted === RENDER_BUDGET_OMISSION) {
					renderBudgetExhausted = true;
				}
				dispatches.set(progress.id, projection);
				const details = createDeltaDetailsFromProjection(params.description, projection.dispatch);
				onUpdate?.({
					content: [{ type: "text", text: formatDispatchLine(projection.dispatch) }],
					details,
				});
			};
			try {
				const outcome = await run({
					program: params.code,
					bindings: {
						global: "tools",
						functions: options.createBindings({
							cwd: ctx.cwd,
							signal: abortSignal,
							reportDispatch,
						}),
					},
					signal: abortSignal,
					timeoutMs: options.timeoutMs,
					maxBindingCalls: options.maxDispatches,
					maxOutputBytes: options.maxOutputBytes,
					maxOutputLines: options.maxOutputLines,
				});
				const progress = [...dispatches.values()].map((projection) => projection.dispatch);
				const details = createSnapshotDetailsFromProjections(params.description, progress);
				return {
					content: [{ type: "text", text: serializeOuterResult(outcome, options) }],
					details,
				};
			} catch (error) {
				const progress = [...dispatches.values()].map((projection) => projection.dispatch);
				const executionError = error instanceof Error ? error.message : String(error);
				const details = createSnapshotDetailsFromProjections(
					params.description,
					progress,
					executionError,
				);
				failureDetails.remember(toolCallId, details);
				throw error;
			}
		},
	};
}

function serializeOuterResult(
	outcome: CodeRunResult,
	limits: { maxOutputBytes: number; maxOutputLines: number },
): string {
	if (outcome.error) {
		const message = "message" in outcome.error ? outcome.error.message : outcome.error.kind;
		throw new Error(`ptc failed (${outcome.error.kind}): ${message}`);
	}
	const outer: { logs: string[]; result?: JsonValue } =
		"result" in outcome ? { logs: outcome.logs, result: outcome.result } : { logs: outcome.logs };
	const text = JSON.stringify(outer);
	if (Buffer.byteLength(text, "utf8") > limits.maxOutputBytes) {
		throw new Error(OUTER_OVERFLOW_BYTES_MESSAGE);
	}
	if (text.split(/\r?\n/).length > limits.maxOutputLines) {
		throw new Error(OUTER_OVERFLOW_LINES_MESSAGE);
	}
	return text;
}
