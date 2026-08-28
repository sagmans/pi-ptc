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
	type PtcDispatchProjection,
	projectDispatchForRetention,
} from "./dispatch-details.ts";
import { attachLiveDispatchResult, transferLiveDispatchAttachments } from "./dispatch-live.ts";
import type { JsonValue } from "./json.ts";
import {
	attachPtcRenderDispatches,
	type PtcDefinitionProvider,
	type PtcDefinitionRegistry,
	renderPtcCall,
	renderPtcResult,
} from "./renderer.ts";
import { type BindingFn, type CodeRunResult, logicalLineCount, runCode } from "./runtime.ts";

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

const RENDER_BUDGET_OMISSION = "budget";
// Downstream result middleware can delay first render, so retain a small FIFO of call tokens.
export const MAX_PENDING_RENDER_SNAPSHOTS = 128;
export const MAX_RENDERER_CALL_ID_HISTORY = 128;

type RendererToken = {
	readonly toolCallId: string;
	readonly epoch: number;
	readonly bareCallIdFallback: boolean;
	state: "pending" | "claimed" | "revoked";
	definitions?: PtcDefinitionRegistry;
};

type PendingRendererSlot =
	| { readonly kind: "token"; readonly token: RendererToken }
	| { readonly kind: "ambiguous" };

type RendererTokens = {
	begin(toolCallId: string): RendererToken;
	provide(token: RendererToken, definitions: PtcDefinitionRegistry | undefined): void;
	attach(details: object, token: RendererToken): void;
	claim(details: unknown, toolCallId: string): PtcDefinitionRegistry | undefined;
	revoke(token: RendererToken): void;
	clear(): void;
};

function createRendererTokens(pendingLimit: number, callIdHistoryLimit: number): RendererTokens {
	if (!Number.isSafeInteger(pendingLimit) || pendingLimit < 1) {
		throw new RangeError("Pending renderer snapshot limit must be a positive safe integer");
	}
	if (!Number.isSafeInteger(callIdHistoryLimit) || callIdHistoryLimit < 1) {
		throw new RangeError("Renderer call-ID history limit must be a positive safe integer");
	}
	let lifecycleEpoch = 0;
	let bareCallIdFallbackEnabled = true;
	const callIdHistory = new Set<string>();
	const pending = new Map<string, PendingRendererSlot>();
	const attachments = new WeakMap<object, RendererToken>();
	const isPending = (token: RendererToken): boolean =>
		token.state === "pending" && token.epoch === lifecycleEpoch;
	const reserveBareCallIdFallback = (toolCallId: string): boolean => {
		if (!bareCallIdFallbackEnabled || callIdHistory.has(toolCallId)) return false;
		// Never evict one ID: forgetting it could authorize a stale clone after reuse.
		if (callIdHistory.size >= callIdHistoryLimit) {
			bareCallIdFallbackEnabled = false;
			callIdHistory.clear();
			return false;
		}
		callIdHistory.add(toolCallId);
		return true;
	};
	const removePendingToken = (token: RendererToken): void => {
		const slot = pending.get(token.toolCallId);
		if (slot?.kind === "token" && slot.token === token) pending.delete(token.toolCallId);
	};
	const revoke = (token: RendererToken): void => {
		if (token.state === "revoked") return;
		token.state = "revoked";
		token.definitions = undefined;
		removePendingToken(token);
	};
	const enforceLimit = (): void => {
		while (pending.size > pendingLimit) {
			const oldestCallId = pending.keys().next().value;
			if (oldestCallId === undefined) break;
			const oldest = pending.get(oldestCallId);
			if (oldest?.kind === "token") revoke(oldest.token);
			pending.delete(oldestCallId);
		}
	};
	const claimToken = (
		token: RendererToken,
		toolCallId: string,
	): PtcDefinitionRegistry | undefined => {
		if (!isPending(token) || token.toolCallId !== toolCallId || !token.definitions) {
			return undefined;
		}
		const definitions = token.definitions;
		token.state = "claimed";
		token.definitions = undefined;
		removePendingToken(token);
		return definitions;
	};
	return {
		begin(toolCallId) {
			const token: RendererToken = {
				toolCallId,
				epoch: lifecycleEpoch,
				bareCallIdFallback: reserveBareCallIdFallback(toolCallId),
				state: "pending",
			};
			const existing = pending.get(toolCallId);
			if (existing) {
				if (existing.kind === "token") revoke(existing.token);
				revoke(token);
				pending.delete(toolCallId);
				pending.set(toolCallId, { kind: "ambiguous" });
			} else {
				pending.set(toolCallId, { kind: "token", token });
			}
			enforceLimit();
			return token;
		},
		provide(token, definitions) {
			if (!isPending(token)) return;
			if (!definitions) {
				revoke(token);
				return;
			}
			token.definitions = definitions;
		},
		attach(details, token) {
			attachments.set(details, token);
		},
		claim(details, toolCallId) {
			if (typeof details === "object" && details !== null) {
				const attached = attachments.get(details);
				if (attached) return claimToken(attached, toolCallId);
			}
			if (!bareCallIdFallbackEnabled) return undefined;
			const slot = pending.get(toolCallId);
			return slot?.kind === "token" && slot.token.bareCallIdFallback
				? claimToken(slot.token, toolCallId)
				: undefined;
		},
		revoke,
		clear() {
			lifecycleEpoch += 1;
			// Serialized details carry no lifecycle generation, so bare lookup cannot resume safely.
			bareCallIdFallbackEnabled = false;
			callIdHistory.clear();
			for (const slot of pending.values()) {
				if (slot.kind === "token") revoke(slot.token);
			}
			pending.clear();
		},
	};
}

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

type PtcExecution = {
	bindings: Record<string, BindingFn>;
	definitions?: PtcDefinitionRegistry;
};

type PtcToolOptions = {
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
			const dispatches = new Map<number, PtcDispatchProjection>();
			const liveDispatches = new Map<number, DispatchProgress>();
			let definitionsProvided = false;
			let retainedRenderBytes = 0;
			let renderBudgetExhausted = false;
			let acceptingDispatchReports = true;
			const reportDispatch = (progress: DispatchProgress) => {
				if (!acceptingDispatchReports) return;
				liveDispatches.set(progress.id, progress);
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
				for (const projection of [...dispatches.values()]) {
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
				const definitions = execution.definitions ? new Map(execution.definitions) : undefined;
				rendererTokens.provide(rendererToken, definitions);
				definitionsProvided = true;
				const outcome = await run({
					program: params.code,
					bindings: {
						global: "tools",
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
				const progress = [...dispatches.values()].map((projection) => projection.dispatch);
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
				const progress = [...dispatches.values()].map((projection) => projection.dispatch);
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
			}
		},
	};
}

function attachExecutionRenderData(
	details: object,
	dispatches: readonly DispatchProgress[],
	token: RendererToken,
	rendererTokens: RendererTokens,
): void {
	attachPtcRenderDispatches(details, dispatches);
	rendererTokens.attach(details, token);
}

function serializeOuterResult(
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

function assertOuterResultWithinLimits(
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
