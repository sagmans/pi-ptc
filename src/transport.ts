// One model-visible tool. Intermediate binding values stay off the transcript.

import { Type } from "typebox";
import {
	EMPTY_DESCRIPTION_MESSAGE,
	SHIPPED_PTC_CONFIG,
	TRANSPORT_NAME,
	TRUST_COPY,
} from "./config.ts";
import type { DispatchProgress, DispatchRenderResult } from "./dispatch-contract.ts";
import {
	createDeltaDetailsFromProjection,
	createSnapshotDetailsFromProjections,
	type PtcDispatchDetails,
} from "./dispatch-details.ts";
import { formatDispatchLine } from "./dispatch-format.ts";
import { attachLiveDispatchResult, transferLiveDispatchAttachments } from "./dispatch-live.ts";
import { createDispatchRetentionLedger } from "./dispatch-retention.ts";
import { formatCodeRunFailure } from "./failure-guidance.ts";
import type { JsonValue } from "./json.ts";
import * as outputLimit from "./output-limit.ts";
import type {
	FailureDetailsStore,
	PtcBindingContext,
	PtcExecuteContext,
	PtcExecution,
	PtcOnUpdate,
	PtcParams,
	PtcToolResult,
} from "./ptc-tool-contract.ts";
import { type PtcDefinitionProvider, renderPtcCall, renderPtcResult } from "./renderer.ts";
import type { RendererToken, RendererTokens } from "./renderer-definition-store.ts";
import {
	createRendererTokens,
	MAX_PENDING_RENDER_SNAPSHOTS,
	MAX_RENDERER_CALL_ID_HISTORY,
} from "./renderer-definition-store.ts";
import {
	createRawRenderStore,
	type RawRenderStore,
	type RawRenderToken,
} from "./renderer-raw-store.ts";
import { type BindingFn, type CodeRunResult, logicalLineCount, runCode } from "./runtime.ts";

export type {
	FailureDetailsStore,
	PtcBindingContext,
	PtcExecuteContext,
	PtcExecution,
	PtcOnUpdate,
	PtcParams,
	PtcPartialResult,
	PtcToolResult,
} from "./ptc-tool-contract.ts";
export {
	MAX_PENDING_RENDER_SNAPSHOTS,
	MAX_RENDERER_CALL_ID_HISTORY,
} from "./renderer-definition-store.ts";

export const RENDER_BUDGET_OMISSION = "budget";

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

export const PTC_PARAMETERS = Type.Object({
	code: Type.String({
		description: "Body of an async function. Top-level await and return are legal.",
	}),
	description: Type.String({
		description: "Short UI label for this program, in active voice.",
	}),
});

export type PtcToolOptions = {
	timeoutMs: number;
	drainTimeoutMs?: number;
	maxDispatches: number;
	maxRenderDetailsBytes?: number;
	maxPersistedDetailsBytes?: number;
	maxOutputBytes: number;
	maxOutputLines: number;
	maxPendingRenderSnapshots?: number;
	maxRendererCallIdHistory?: number;
	definitionProvider?: PtcDefinitionProvider;
	rawRenderStore?: RawRenderStore;
	run?: typeof runCode;
} & (
	| {
			createExecution: (ctx: PtcBindingContext) => PtcExecution;
			createBindings?: never;
	  }
	| {
			createExecution?: never;
			createBindings: (ctx: PtcBindingContext) => Record<string, BindingFn>;
	  }
);

export function createPtcTool(options: PtcToolOptions) {
	const run = options.run ?? runCode;
	const rawRenderStore = options.rawRenderStore ?? createRawRenderStore();
	const rendererTokens = createRendererTokens(
		options.maxPendingRenderSnapshots ?? MAX_PENDING_RENDER_SNAPSHOTS,
		options.maxRendererCallIdHistory ?? MAX_RENDERER_CALL_ID_HISTORY,
	);
	const maxRenderDetailsBytes =
		options.maxRenderDetailsBytes ?? SHIPPED_PTC_CONFIG.maxRenderDetailsBytes;
	const maxPersistedDetailsBytes =
		options.maxPersistedDetailsBytes ?? SHIPPED_PTC_CONFIG.maxPersistedDetailsBytes;
	const renderResult: typeof renderPtcResult = (result, renderOptions, theme, context) =>
		renderPtcResult(
			result,
			renderOptions,
			theme,
			context,
			options.definitionProvider,
			context.state.root?.cwd === context.cwd
				? undefined
				: rendererTokens.claim(result.details, context.toolCallId),
			rawRenderStore,
		);
	return {
		name: TRANSPORT_NAME,
		label: "PTC",
		description: `Execute a TypeScript program against active runtime tools. ${TRUST_COPY}`,
		promptSnippet: "Run a program against active runtime tools",
		parameters: PTC_PARAMETERS,
		renderShell: "self" as const,
		renderCall: renderPtcCall,
		renderResult,
		clearRenderSnapshots(): void {
			rawRenderStore.clear();
			rendererTokens.clear();
		},
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
			const rawRenderToken = rawRenderStore.begin();
			const rendererToken = rendererTokens.begin(toolCallId);
			const abortSignal = signal ?? ctx.signal;
			const retention = createDispatchRetentionLedger(maxRenderDetailsBytes);
			const liveDispatches = new Map<number, DispatchProgress>();
			let definitionsProvided = false;
			let acceptingDispatchReports = true;
			let recordFailure: FailureDetailsStore["remember"] | undefined;
			let releaseExecution: (() => void) | undefined;
			const reportDispatch = (progress: DispatchProgress) => {
				if (!acceptingDispatchReports) return;
				liveDispatches.set(progress.id, progress);
				const projection = retention.retain(progress);
				const details = createDeltaDetailsFromProjection(
					params.description,
					projection.dispatch,
					maxPersistedDetailsBytes,
				);
				attachExecutionRenderData(
					details,
					[progress],
					rendererToken,
					rendererTokens,
					rawRenderStore,
					rawRenderToken,
				);
				onUpdate?.({
					content: [{ type: "text", text: formatDispatchLine(projection.dispatch) }],
					details,
				});
			};
			const terminalizeActiveDispatches = (message: string): void => {
				for (const projection of retention.snapshot()) {
					if (projection.dispatch.status !== "start") continue;
					const result: DispatchRenderResult = {
						content: [{ type: "text", text: message }],
						isError: true,
					};
					const terminal: DispatchProgress = {
						...projection.dispatch,
						status: "err",
						preview: message,
						result,
					};
					const live = liveDispatches.get(projection.dispatch.id);
					if (live) transferLiveDispatchAttachments(live, terminal);
					attachLiveDispatchResult(terminal, result, result);
					reportDispatch(terminal);
				}
			};
			try {
				const bindingContext: PtcBindingContext = {
					cwd: ctx.cwd,
					signal: abortSignal,
					reportDispatch,
					isOpen: () => acceptingDispatchReports,
				};
				const execution = options.createExecution
					? options.createExecution(bindingContext)
					: { bindings: options.createBindings(bindingContext) };
				recordFailure = execution.recordFailure;
				releaseExecution = execution.release;
				const definitions = execution.definitions ? new Map(execution.definitions) : undefined;
				rendererTokens.provide(rendererToken, definitions);
				definitionsProvided = true;
				const outcome = await run({
					program: params.code,
					bindings: {
						functions: execution.bindings,
					},
					signal: abortSignal,
					timeoutMs: options.timeoutMs,
					drainTimeoutMs: options.drainTimeoutMs,
					maxBindingCalls: options.maxDispatches,
					maxOutputBytes: options.maxOutputBytes,
					maxOutputLines: options.maxOutputLines,
				});
				if (outcome.error) terminalizeActiveDispatches(describeRunFailure(outcome.error));
				acceptingDispatchReports = false;
				const progress = retention.snapshot().map((projection) => projection.dispatch);
				const details = createSnapshotDetailsFromProjections(
					params.description,
					progress,
					undefined,
					maxPersistedDetailsBytes,
				);
				attachExecutionRenderData(
					details,
					progress.map((dispatch) => liveDispatches.get(dispatch.id) ?? dispatch),
					rendererToken,
					rendererTokens,
					rawRenderStore,
					rawRenderToken,
				);
				return {
					content: [{ type: "text", text: serializeOuterResult(outcome, options) }],
					details,
				};
			} catch (error) {
				if (!definitionsProvided) rendererTokens.revoke(rendererToken);
				const executionError = error instanceof Error ? error.message : String(error);
				terminalizeActiveDispatches(executionError);
				acceptingDispatchReports = false;
				const progress = retention.snapshot().map((projection) => projection.dispatch);
				const details = createSnapshotDetailsFromProjections(
					params.description,
					progress,
					executionError,
					maxPersistedDetailsBytes,
				);
				attachExecutionRenderData(
					details,
					progress.map((dispatch) => liveDispatches.get(dispatch.id) ?? dispatch),
					rendererToken,
					rendererTokens,
					rawRenderStore,
					rawRenderToken,
				);
				recordFailure?.(toolCallId, details);
				throw error;
			} finally {
				releaseExecution?.();
			}
		},
	};
}

export function attachExecutionRenderData(
	details: object,
	dispatches: readonly DispatchProgress[],
	token: RendererToken,
	rendererTokens: RendererTokens,
	rawRenderStore: RawRenderStore,
	rawRenderToken: RawRenderToken,
): void {
	rawRenderStore.attach(details, dispatches, rawRenderToken);
	rendererTokens.attach(details, token);
}

function describeRunFailure(error: NonNullable<CodeRunResult["error"]>): string {
	return formatCodeRunFailure(error);
}

export function serializeOuterResult(
	outcome: CodeRunResult,
	limits: { maxOutputBytes: number; maxOutputLines: number },
): string {
	if (outcome.error) throw new Error(describeBoundedRunFailure(outcome.error, limits));
	const outer: { logs: string[]; result?: JsonValue } =
		"result" in outcome ? { logs: outcome.logs, result: outcome.result } : { logs: outcome.logs };
	const text = JSON.stringify(outer);
	assertOuterResultWithinLimits(text, limits);
	return text;
}

function describeBoundedRunFailure(
	error: NonNullable<CodeRunResult["error"]>,
	limits: { maxOutputBytes: number; maxOutputLines: number },
): string {
	const failure = describeRunFailure(error);
	try {
		assertOuterResultWithinLimits(failure, limits);
		return failure;
	} catch (limitError) {
		const message = limitError instanceof Error ? limitError.message : String(limitError);
		const fallback = formatCodeRunFailure({ kind: "output-limit", message });
		assertOuterResultWithinLimits(fallback, limits);
		return fallback;
	}
}

export function assertOuterResultWithinLimits(
	text: string,
	limits: { maxOutputBytes: number; maxOutputLines: number },
): void {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > limits.maxOutputBytes) {
		throw new Error(
			outputLimit.describe(
				outputLimit.OUTER_RESULT_SUBJECT,
				outputLimit.MAX_OUTPUT_BYTES_NAME,
				bytes,
				limits.maxOutputBytes,
			),
		);
	}
	const lines = logicalLineCount(text);
	if (lines > limits.maxOutputLines) {
		throw new Error(
			outputLimit.describe(
				outputLimit.OUTER_RESULT_SUBJECT,
				outputLimit.MAX_OUTPUT_LINES_NAME,
				lines,
				limits.maxOutputLines,
			),
		);
	}
}
