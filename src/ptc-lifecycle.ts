import {
	COMPETING_OWNER_MESSAGE,
	LEAK_BLOCK_REASON,
	MISSING_TRANSPORT_MESSAGE,
	type Presentation,
	STATUS_KEY,
	TRANSPORT_NAME,
} from "./config.ts";
import type { ExtensionAPI, ExtensionContext } from "./host.ts";
import type {
	CapturedPiSession,
	PiRuntimeCapture,
	PiRuntimeEventFinalizersInstallation,
	PtcTransportOwnership,
} from "./pi-runtime.ts";
import { hasCompetingOwner } from "./presentation.ts";
import { createPtcExecution } from "./ptc-execution.ts";
import type {
	PtcExecutionLease,
	PtcLifecycle,
	PtcLifecycleClearReason,
} from "./ptc-tool-contract.ts";
import { renderSdkPrompt, renderSkillsPrompt, type SkillPromptInput } from "./sdk.ts";
import {
	createToolCatalog,
	type ToolCatalog,
	type ToolCatalogRefreshFailure,
} from "./tool-catalog.ts";
import { createToolExecutor, isNestedPtcToolCall } from "./tool-executor.ts";
import type { FailureDetailsStore, PtcBindingContext, PtcExecution } from "./transport.ts";

const INERT_STATUS = "ptc: inert";
const MISSING_RUNTIME_CAPTURE_MESSAGE = "pi-ptc staying inert: ptc runtime capture is missing";
const RUNTIME_INCOMPATIBILITY_PREFIX = "pi-ptc staying inert";
const PTC_RUNTIME_UNAVAILABLE_MESSAGE = "ptc runtime capture is unavailable";
const OBSOLETE_CAPTURE_CONTRACT_MESSAGE =
	"captured Pi runtime does not provide exact argument preparation";
const OWNED_TRANSPORT_CLEANUP_FAILURE_PREFIX = "owned ptc transport cleanup failed";
const CATALOG_ROLLBACK_FAILURE_PREFIX = "catalog rollback failed";
const NATIVE_RESTORATION_RETRY_FAILURE_PREFIX = "native active-tool restoration retry failed";
const NATIVE_RESTORATION_VERIFICATION_FAILURE =
	"native active-tool restoration verification failed";
const TOOL_CALL_EVENT_ARGUMENT_INDEX = 0;
const BEFORE_AGENT_START_SYSTEM_PROMPT_ARGUMENT_INDEX = 2;
const BEFORE_AGENT_START_OPTIONS_ARGUMENT_INDEX = 3;

type CaptureReadiness = "pending" | "active" | "inert";
type AggregatedToolCallResult = { block?: unknown };
type AggregatedBeforeAgentStartResult = { messages?: unknown; systemPrompt?: unknown };

export type PtcLifecycleOptions = {
	readonly pi: ExtensionAPI;
	readonly initialPresentation: Presentation;
	readonly maxParallelDispatches: number;
	readonly failureDetails: FailureDetailsStore;
	clearRenderSnapshots(): void;
};

export interface PtcLifecycleController extends PtcLifecycle {
	readonly presentation: Presentation;
	setPresentation(presentation: Presentation): void;
	sessionStart(context: ExtensionContext, presentation: Presentation): void;
	apply(context: ExtensionContext): void;
	requireActive(context: ExtensionContext): boolean;
	markRuntimeEventReadiness(context: ExtensionContext): void;
	finalizeToolCall(args: readonly unknown[], result: unknown, context: unknown): unknown;
	finalizeBeforeAgentStart(args: readonly unknown[], result: unknown, context: unknown): unknown;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isBlockingToolCallResult(value: unknown): value is AggregatedToolCallResult {
	return isRecord(value) && value.block === true;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
	return (
		actual.length === expected.length && actual.every((name, index) => name === expected[index])
	);
}

function supportsCurrentCaptureContract(session: CapturedPiSession): boolean {
	return (
		typeof (session as unknown as { prepareToolArguments?: unknown }).prepareToolArguments ===
		"function"
	);
}

export function createPtcLifecycle(options: PtcLifecycleOptions): PtcLifecycleController {
	let presentation = options.initialPresentation;
	let catalog: ToolCatalog | undefined;
	let capturedSession: CapturedPiSession | undefined;
	let eventFinalizers: PiRuntimeEventFinalizersInstallation | undefined;
	let transportOwnership: PtcTransportOwnership | undefined;
	let captureReadiness: CaptureReadiness = "pending";
	let lastContext: ExtensionContext | undefined;
	let inertMessage: string | undefined;
	let reportedInertMessage: string | undefined;
	let generation = 0;

	const reportInert = (context: ExtensionContext): void => {
		if (!inertMessage || reportedInertMessage === inertMessage) return;
		context.ui.notify(inertMessage, "warning");
		context.ui.setStatus(STATUS_KEY, INERT_STATUS);
		reportedInertMessage = inertMessage;
	};
	const deactivateOwnedTransport = (): void => {
		const ownership = transportOwnership;
		transportOwnership = undefined;
		if (!ownership?.isCurrent()) return;
		const activeTools = options.pi.getActiveTools();
		if (!activeTools.includes(TRANSPORT_NAME)) return;
		options.pi.setActiveTools(activeTools.filter((name) => name !== TRANSPORT_NAME));
	};
	const restoreCatalog = (): void => {
		const activeCatalog = catalog;
		catalog = undefined;
		capturedSession = undefined;
		generation += 1;
		if (activeCatalog) {
			transportOwnership = undefined;
			activeCatalog.restore();
			return;
		}
		deactivateOwnedTransport();
	};
	const restoreControlledRuntime = (): void => {
		let firstError: unknown;
		const activeFinalizers = eventFinalizers;
		eventFinalizers = undefined;
		try {
			activeFinalizers?.restore();
		} catch (error) {
			firstError = error;
		}
		try {
			restoreCatalog();
		} catch (error) {
			firstError ??= error;
		}
		if (firstError !== undefined) throw firstError;
	};
	const hasActiveCatalog = (): boolean =>
		captureReadiness === "active" &&
		catalog !== undefined &&
		capturedSession !== undefined &&
		inertMessage === undefined;
	const becomeRuntimeInert = (message: string, context?: ExtensionContext): void => {
		options.failureDetails.clear();
		options.clearRenderSnapshots();
		let cleanupError: unknown;
		try {
			restoreControlledRuntime();
		} catch (error) {
			cleanupError = error;
		}
		captureReadiness = "inert";
		inertMessage =
			cleanupError === undefined
				? message
				: `${message}: ${OWNED_TRANSPORT_CLEANUP_FAILURE_PREFIX}: ${describeError(cleanupError)}`;
		if (context) reportInert(context);
	};
	const becomeCapturedRuntimeInert = (error: unknown, context?: ExtensionContext): void => {
		becomeRuntimeInert(`${RUNTIME_INCOMPATIBILITY_PREFIX}: ${describeError(error)}`, context);
	};
	const becomeRefreshFailureInert = (
		failure: ToolCatalogRefreshFailure,
		context?: ExtensionContext,
	): void => {
		let message = `${RUNTIME_INCOMPATIBILITY_PREFIX}: ${describeError(failure.refreshError)}`;
		if (failure.rollbackFailed) {
			message += `: ${CATALOG_ROLLBACK_FAILURE_PREFIX}: ${describeError(failure.rollbackError)}`;
			try {
				options.pi.setActiveTools([...failure.previousLogicalActiveTools]);
				if (!sameNames(options.pi.getActiveTools(), failure.previousLogicalActiveTools)) {
					throw new Error(NATIVE_RESTORATION_VERIFICATION_FAILURE);
				}
			} catch (error) {
				message += `: ${NATIVE_RESTORATION_RETRY_FAILURE_PREFIX}: ${describeError(error)}`;
			}
		}
		becomeRuntimeInert(message, context);
	};
	const becomeCompetingOwnerInert = (context: ExtensionContext): void => {
		becomeRuntimeInert(COMPETING_OWNER_MESSAGE, context);
	};
	const becomeMissingCaptureInert = (context: ExtensionContext): void => {
		if (captureReadiness === "pending" && !catalog && !inertMessage) {
			captureReadiness = "inert";
			inertMessage = MISSING_RUNTIME_CAPTURE_MESSAGE;
		}
		reportInert(context);
	};
	const requireNoCompetingOwner = (context: ExtensionContext): boolean => {
		lastContext = context;
		if (!hasCompetingOwner(options.pi.getAllTools().map((tool) => tool.name))) return true;
		becomeCompetingOwnerInert(context);
		return false;
	};
	const apply = (context: ExtensionContext): void => {
		if (!hasActiveCatalog()) {
			if (inertMessage) reportInert(context);
			return;
		}
		try {
			const resolved = catalog?.applyPhysical();
			if (resolved?.missingTransport) {
				presentation = "native";
				context.ui.notify(MISSING_TRANSPORT_MESSAGE, "warning");
			}
			context.ui.setStatus(STATUS_KEY, `ptc: ${presentation}`);
		} catch (error) {
			becomeCapturedRuntimeInert(error, context);
		}
	};
	const controller: PtcLifecycleController = {
		get presentation() {
			return presentation;
		},
		setPresentation(value) {
			presentation = value;
		},
		sessionStart(context, value) {
			lastContext = context;
			presentation = value;
			if (!requireNoCompetingOwner(context)) return;
			if (inertMessage) {
				reportInert(context);
				return;
			}
			if (captureReadiness !== "pending") apply(context);
		},
		apply,
		requireActive(context) {
			if (!requireNoCompetingOwner(context)) return false;
			if (captureReadiness === "pending") becomeMissingCaptureInert(context);
			if (!hasActiveCatalog()) {
				if (inertMessage) reportInert(context);
				return false;
			}
			return true;
		},
		markRuntimeEventReadiness(context) {
			lastContext = context;
			if (captureReadiness === "pending") becomeMissingCaptureInert(context);
			else if (inertMessage) reportInert(context);
		},
		capture(capture: PiRuntimeCapture) {
			try {
				restoreControlledRuntime();
			} catch (error) {
				becomeCapturedRuntimeInert(error, lastContext);
				return;
			}
			captureReadiness = "pending";
			transportOwnership = capture.transportOwnership;
			if (!capture.compatible) {
				becomeRuntimeInert(capture.diagnostic, lastContext);
				return;
			}
			if (hasCompetingOwner(options.pi.getAllTools().map((tool) => tool.name))) {
				becomeRuntimeInert(COMPETING_OWNER_MESSAGE, lastContext);
				return;
			}
			if (!supportsCurrentCaptureContract(capture.session)) {
				becomeRuntimeInert(
					`${RUNTIME_INCOMPATIBILITY_PREFIX}: ${OBSOLETE_CAPTURE_CONTRACT_MESSAGE}`,
					lastContext,
				);
				return;
			}
			inertMessage = undefined;
			reportedInertMessage = undefined;
			try {
				catalog = createToolCatalog({
					session: capture.session,
					getPresentation: () => presentation,
					onRefreshFailure: (failure) => becomeRefreshFailureInert(failure, lastContext),
				});
				eventFinalizers = capture.session.installRuntimeEventFinalizers({
					finalizeToolCall: controller.finalizeToolCall,
					finalizeBeforeAgentStart: controller.finalizeBeforeAgentStart,
				});
				capturedSession = capture.session;
				generation += 1;
			} catch (error) {
				becomeCapturedRuntimeInert(error, lastContext);
				return;
			}
			captureReadiness = "active";
			if (lastContext) apply(lastContext);
		},
		issueExecutionLease() {
			const activeCatalog = catalog;
			const activeSession = capturedSession;
			if (!hasActiveCatalog() || !activeCatalog || !activeSession) {
				if (captureReadiness === "pending" && lastContext) becomeMissingCaptureInert(lastContext);
				throw new Error(PTC_RUNTIME_UNAVAILABLE_MESSAGE);
			}
			const leaseGeneration = generation;
			const snapshot = activeCatalog.snapshot();
			let released = false;
			const assertCurrent = (): void => {
				if (
					released ||
					leaseGeneration !== generation ||
					catalog !== activeCatalog ||
					capturedSession !== activeSession ||
					!hasActiveCatalog()
				) {
					throw new Error(PTC_RUNTIME_UNAVAILABLE_MESSAGE);
				}
			};
			const transitionToInert = (error: unknown, context?: ExtensionContext): void => {
				if (!released && leaseGeneration === generation) {
					becomeCapturedRuntimeInert(error, context);
				}
			};
			const dispatch = createToolExecutor({
				catalog: snapshot,
				session: activeSession,
				activateTools(names) {
					assertCurrent();
					activeCatalog.activateAvailable(names);
				},
				onActivationFailure(error) {
					transitionToInert(error, lastContext);
				},
			});
			return Object.freeze({
				generation: leaseGeneration,
				catalog: snapshot,
				dispatch,
				assertCurrent,
				transitionToInert,
				release() {
					released = true;
				},
			}) satisfies PtcExecutionLease;
		},
		createExecution(context: PtcBindingContext): PtcExecution {
			const lease = controller.issueExecutionLease();
			const execution = createPtcExecution({
				lease,
				maxParallelDispatches: options.maxParallelDispatches,
				context,
				pi: options.pi,
				lastContext,
			});
			return { ...execution, release: lease.release };
		},
		consumeFailure(toolCallId) {
			return options.failureDetails.consume(toolCallId);
		},
		clear(_reason: PtcLifecycleClearReason) {
			options.failureDetails.clear();
			options.clearRenderSnapshots();
			restoreControlledRuntime();
			captureReadiness = "pending";
			inertMessage = undefined;
			reportedInertMessage = undefined;
			lastContext = undefined;
		},
		finalizeToolCall(args, result, rawContext) {
			const context = rawContext as ExtensionContext;
			if (!requireNoCompetingOwner(context) || !hasActiveCatalog()) return result;
			const event = args[TOOL_CALL_EVENT_ARGUMENT_INDEX] as
				| { toolCallId?: unknown; toolName?: unknown }
				| undefined;
			if (typeof event?.toolCallId === "string" && isNestedPtcToolCall(event.toolCallId)) {
				return result;
			}
			if (isBlockingToolCallResult(result) || presentation !== "code") return result;
			if (typeof event?.toolName !== "string") return result;
			try {
				return catalog?.getLogicalActiveTools().includes(event.toolName)
					? { block: true, reason: LEAK_BLOCK_REASON }
					: result;
			} catch (error) {
				becomeCapturedRuntimeInert(error, context);
				return result;
			}
		},
		finalizeBeforeAgentStart(args, result, rawContext) {
			const context = rawContext as ExtensionContext;
			if (!requireNoCompetingOwner(context) || !hasActiveCatalog() || presentation === "native") {
				if (inertMessage) reportInert(context);
				return result;
			}
			let sdkPrompt: string;
			try {
				const snapshot = catalog?.snapshot();
				if (!snapshot) return result;
				sdkPrompt = renderSdkPrompt(snapshot);
			} catch (error) {
				becomeCapturedRuntimeInert(error, context);
				return result;
			}
			const aggregate = isRecord(result) ? (result as AggregatedBeforeAgentStartResult) : undefined;
			const originalPrompt = args[BEFORE_AGENT_START_SYSTEM_PROMPT_ARGUMENT_INDEX];
			const effectivePrompt =
				typeof aggregate?.systemPrompt === "string"
					? aggregate.systemPrompt
					: typeof originalPrompt === "string"
						? originalPrompt
						: "";
			let systemPrompt = `${effectivePrompt}\n\n${sdkPrompt}`;
			if (presentation === "code") {
				const promptOptions = args[BEFORE_AGENT_START_OPTIONS_ARGUMENT_INDEX] as
					| { skills?: SkillPromptInput[] }
					| undefined;
				systemPrompt += renderSkillsPrompt(promptOptions?.skills ?? []);
			}
			return aggregate ? { ...aggregate, systemPrompt } : { systemPrompt };
		},
	};
	return Object.freeze(controller);
}
