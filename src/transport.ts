// One model-visible tool. Intermediate binding values stay off the transcript.

import { Type } from "typebox";
import { type DispatchProgress, type DispatchRenderResult, formatDispatchLine } from "./bridge.ts";
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
} from "./dispatch-details.ts";
import { attachLiveDispatchResult, transferLiveDispatchAttachments } from "./dispatch-live.ts";
import { createDispatchRetentionLedger } from "./dispatch-retention.ts";
import type { JsonValue } from "./json.ts";
import {
	attachPtcRenderDispatches,
	type PtcDefinitionProvider,
	type PtcDefinitionRegistry,
	renderPtcCall,
	renderPtcResult,
} from "./renderer.ts";
import type { RendererToken, RendererTokens } from "./renderer-definition-store.ts";
import {
	createRendererTokens,
	MAX_PENDING_RENDER_SNAPSHOTS,
	MAX_RENDERER_CALL_ID_HISTORY,
} from "./renderer-definition-store.ts";
import { type BindingFn, type CodeRunResult, logicalLineCount, runCode } from "./runtime.ts";

export {
	MAX_PENDING_RENDER_SNAPSHOTS,
	MAX_RENDERER_CALL_ID_HISTORY,
} from "./renderer-definition-store.ts";
export type PtcParams = {
	code: string;
	description: string;
};

export type PtcExecuteContext = {
	cwd: string;
	signal?: AbortSignal;
};

export type PtcBindingContext = PtcExecuteContext & {
	reportDispatch?: (progress: DispatchProgress) => void;
	isOpen(): boolean;
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

export const RENDER_BUDGET_OMISSION = "budget";

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

export const PTC_PARAMETERS = Type.Object({
	code: Type.String({
		description: "Body of an async function. Top-level await and return are legal.",
	}),
	description: Type.String({
		description: "Short UI label for this program, in active voice.",
	}),
});

export type PtcExecution = {
	bindings: Record<string, BindingFn>;
	definitions?: PtcDefinitionRegistry;
	release?(): void;
};

export type PtcToolOptions = {
	timeoutMs: number;
	drainTimeoutMs?: number;
	maxOrphanedBindings?: number;
	maxDispatches: number;
	maxRenderDetailsBytes?: number;
	maxPersistedDetailsBytes?: number;
	maxOutputBytes: number;
	maxOutputLines: number;
	maxPendingRenderSnapshots?: number;
	maxRendererCallIdHistory?: number;
	definitionProvider?: PtcDefinitionProvider;
	failureDetails?: FailureDetailsStore;
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
	const failureDetails = options.failureDetails ?? createFailureDetailsStore();
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
			const rendererToken = rendererTokens.begin(toolCallId);
			const abortSignal = signal ?? ctx.signal;
			const retention = createDispatchRetentionLedger(maxRenderDetailsBytes);
			const liveDispatches = new Map<number, DispatchProgress>();
			let definitionsProvided = false;
			let acceptingDispatchReports = true;
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
				attachExecutionRenderData(details, [progress], rendererToken, rendererTokens);
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
					maxOrphanedBindings: options.maxOrphanedBindings,
					maxOutputBytes: options.maxOutputBytes,
					maxOutputLines: options.maxOutputLines,
				});
				if (outcome.error) {
					terminalizeActiveDispatches(
						"message" in outcome.error ? outcome.error.message : outcome.error.kind,
					);
				}
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
				);
				failureDetails.remember(toolCallId, details);
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
): void {
	attachPtcRenderDispatches(details, dispatches);
	rendererTokens.attach(details, token);
}

export function serializeOuterResult(
	outcome: CodeRunResult,
	limits: { maxOutputBytes: number; maxOutputLines: number },
): string {
	if (outcome.error) {
		const message = "message" in outcome.error ? outcome.error.message : outcome.error.kind;
		const failure = `ptc failed (${outcome.error.kind}): ${message}`;
		assertOuterResultWithinLimits(failure, limits);
		throw new Error(failure);
	}
	const outer: { logs: string[]; result?: JsonValue } =
		"result" in outcome ? { logs: outcome.logs, result: outcome.result } : { logs: outcome.logs };
	const text = JSON.stringify(outer);
	assertOuterResultWithinLimits(text, limits);
	return text;
}

export function assertOuterResultWithinLimits(
	text: string,
	limits: { maxOutputBytes: number; maxOutputLines: number },
): void {
	if (Buffer.byteLength(text, "utf8") > limits.maxOutputBytes) {
		throw new Error(OUTER_OVERFLOW_BYTES_MESSAGE);
	}
	if (logicalLineCount(text) > limits.maxOutputLines) {
		throw new Error(OUTER_OVERFLOW_LINES_MESSAGE);
	}
}
