import { join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	COMPETING_OWNER_MESSAGE,
	cyclePresentation,
	DISPATCH_LOG_TYPE,
	LEAK_BLOCK_REASON,
	loadPresentation,
	MISSING_TRANSPORT_MESSAGE,
	PRESENTATION_FILE_NAME,
	type Presentation,
	parsePresentationArg,
	SHIPPED_PTC_CONFIG,
	STATUS_KEY,
	savePresentation,
	TRANSPORT_NAME,
} from "./config.ts";
import type { DispatchLogEntry } from "./dispatch-contract.ts";
import type { ExtensionAPI, ExtensionContext } from "./host.ts";
import {
	type CapturedPiSession,
	ensureSharedPiRuntimeCapturePatch,
	type PiRuntimeEventFinalizersInstallation,
	type PiRuntimeInstaller,
	type PiRuntimePatchInstallation,
	type PiRuntimeSharedPatchEnsure,
	type PtcTransportOwnership,
	tagPtcToolDefinition,
} from "./pi-runtime.ts";
import { hasCompetingOwner } from "./presentation.ts";
import { createPtcDefinitionRegistry } from "./renderer.ts";
import { createScheduler } from "./scheduler.ts";
import { renderSdkPrompt, renderSkillsPrompt, type SkillPromptInput } from "./sdk.ts";
import { createToolBindings } from "./tool-bindings.ts";
import {
	createToolCatalog,
	type ToolCatalog,
	type ToolCatalogRefreshFailure,
} from "./tool-catalog.ts";
import { createToolExecutor, isNestedPtcToolCall } from "./tool-executor.ts";
import { createFailureDetailsStore, createPtcTool } from "./transport.ts";

export type PathResolver = (cwd: string) => { projectFile: string; userFile: string };
export type RuntimeCaptureInstaller = (
	installer: PiRuntimeInstaller,
) => PiRuntimePatchInstallation | PiRuntimeSharedPatchEnsure;

export type InstallPtcOptions = {
	resolvePaths?: PathResolver;
	installRuntimeCapture?: RuntimeCaptureInstaller;
};

const PTC_COMMAND_USAGE = "Usage: /ptc [on|both|off]";
const INERT_STATUS = "ptc: inert";
const MISSING_RUNTIME_CAPTURE_MESSAGE = "pi-ptc staying inert: ptc runtime capture is missing";
const RUNTIME_INCOMPATIBILITY_PREFIX = "pi-ptc staying inert";
const PTC_RUNTIME_UNAVAILABLE_MESSAGE = "ptc runtime capture is unavailable";
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
type AggregatedBeforeAgentStartResult = {
	messages?: unknown;
	systemPrompt?: unknown;
};

function installDefaultRuntimeCapture(): PiRuntimeSharedPatchEnsure {
	return ensureSharedPiRuntimeCapturePatch();
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

export function defaultPathResolver(cwd: string): { projectFile: string; userFile: string } {
	return {
		projectFile: join(cwd, CONFIG_DIR_NAME, PRESENTATION_FILE_NAME),
		userFile: join(getAgentDir(), PRESENTATION_FILE_NAME),
	};
}

export default function installPtc(pi: ExtensionAPI, options: InstallPtcOptions = {}): void {
	const resolvePaths = options.resolvePaths ?? defaultPathResolver;
	const installRuntimeCapture = options.installRuntimeCapture ?? installDefaultRuntimeCapture;
	const shipped = SHIPPED_PTC_CONFIG;
	let presentation: Presentation = shipped.presentation;
	let catalog: ToolCatalog | undefined;
	let capturedSession: CapturedPiSession | undefined;
	let eventFinalizers: PiRuntimeEventFinalizersInstallation | undefined;
	let transportOwnership: PtcTransportOwnership | undefined;
	let transportTool: ReturnType<typeof createPtcTool> | undefined;
	let captureReadiness: CaptureReadiness = "pending";
	let lastContext: ExtensionContext | undefined;
	let inertMessage: string | undefined;
	let reportedInertMessage: string | undefined;
	const failureDetails = createFailureDetailsStore();

	const reportInert = (ctx: ExtensionContext): void => {
		if (!inertMessage || reportedInertMessage === inertMessage) return;
		ctx.ui.notify(inertMessage, "warning");
		ctx.ui.setStatus(STATUS_KEY, INERT_STATUS);
		reportedInertMessage = inertMessage;
	};
	const deactivateOwnedTransport = (): void => {
		const ownership = transportOwnership;
		transportOwnership = undefined;
		if (!ownership?.isCurrent()) return;
		const activeTools = pi.getActiveTools();
		if (!activeTools.includes(TRANSPORT_NAME)) return;
		pi.setActiveTools(activeTools.filter((name) => name !== TRANSPORT_NAME));
	};
	const restoreCatalog = (): void => {
		const activeCatalog = catalog;
		catalog = undefined;
		capturedSession = undefined;
		if (activeCatalog) {
			transportOwnership = undefined;
			activeCatalog.restore();
			return;
		}
		deactivateOwnedTransport();
	};
	const restoreEventFinalizers = (): void => {
		const activeFinalizers = eventFinalizers;
		eventFinalizers = undefined;
		activeFinalizers?.restore();
	};
	const restoreControlledRuntime = (): void => {
		let firstError: unknown;
		try {
			restoreEventFinalizers();
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
	const becomeRuntimeInert = (message: string, ctx?: ExtensionContext): void => {
		transportTool?.clearRenderSnapshots();
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
				: `${message}: ${OWNED_TRANSPORT_CLEANUP_FAILURE_PREFIX}: ${
						cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
					}`;
		if (ctx) reportInert(ctx);
	};
	const becomeCapturedRuntimeInert = (error: unknown, ctx?: ExtensionContext): void => {
		becomeRuntimeInert(`${RUNTIME_INCOMPATIBILITY_PREFIX}: ${describeError(error)}`, ctx);
	};
	const becomeRefreshFailureInert = (
		failure: ToolCatalogRefreshFailure,
		ctx?: ExtensionContext,
	): void => {
		let message = `${RUNTIME_INCOMPATIBILITY_PREFIX}: ${describeError(failure.refreshError)}`;
		if (failure.rollbackFailed) {
			message += `: ${CATALOG_ROLLBACK_FAILURE_PREFIX}: ${describeError(failure.rollbackError)}`;
			let retryFailed = false;
			let retryFailure: unknown;
			try {
				pi.setActiveTools([...failure.previousLogicalActiveTools]);
				if (!sameNames(pi.getActiveTools(), failure.previousLogicalActiveTools)) {
					throw new Error(NATIVE_RESTORATION_VERIFICATION_FAILURE);
				}
			} catch (error) {
				retryFailed = true;
				retryFailure = error;
			}
			if (retryFailed) {
				message += `: ${NATIVE_RESTORATION_RETRY_FAILURE_PREFIX}: ${describeError(retryFailure)}`;
			}
		}
		becomeRuntimeInert(message, ctx);
	};
	const becomeCompetingOwnerInert = (ctx: ExtensionContext): void => {
		becomeRuntimeInert(COMPETING_OWNER_MESSAGE, ctx);
	};
	const becomeMissingCaptureInert = (ctx: ExtensionContext): void => {
		if (captureReadiness === "pending" && !catalog && !inertMessage) {
			captureReadiness = "inert";
			inertMessage = MISSING_RUNTIME_CAPTURE_MESSAGE;
		}
		reportInert(ctx);
	};
	const requireActiveCatalog = (ctx: ExtensionContext): ToolCatalog | undefined => {
		lastContext = ctx;
		if (hasCompetingOwner(pi.getAllTools().map((tool) => tool.name))) {
			becomeCompetingOwnerInert(ctx);
			return undefined;
		}
		if (captureReadiness === "pending") becomeMissingCaptureInert(ctx);
		if (!hasActiveCatalog()) {
			if (inertMessage) reportInert(ctx);
			return undefined;
		}
		return catalog;
	};
	const apply = (ctx: ExtensionContext): void => {
		if (!hasActiveCatalog()) {
			if (inertMessage) reportInert(ctx);
			return;
		}
		const activeCatalog = catalog;
		if (!activeCatalog) return;
		let resolved: { missingTransport: boolean };
		try {
			resolved = activeCatalog.applyPhysical();
		} catch (error) {
			becomeCapturedRuntimeInert(error, ctx);
			return;
		}
		if (resolved.missingTransport) {
			presentation = "native";
			ctx.ui.notify(MISSING_TRANSPORT_MESSAGE, "warning");
		}
		ctx.ui.setStatus(STATUS_KEY, `ptc: ${presentation}`);
	};
	const markRuntimeEventReadiness = (ctx: ExtensionContext): void => {
		lastContext = ctx;
		if (captureReadiness === "pending") {
			becomeMissingCaptureInert(ctx);
		} else if (inertMessage) {
			reportInert(ctx);
		}
	};
	const finalizeToolCall = (
		args: readonly unknown[],
		result: unknown,
		rawCtx: unknown,
	): unknown => {
		const ctx = rawCtx as ExtensionContext;
		lastContext = ctx;
		if (hasCompetingOwner(pi.getAllTools().map((tool) => tool.name))) {
			becomeCompetingOwnerInert(ctx);
			return result;
		}
		if (!hasActiveCatalog()) {
			if (inertMessage) reportInert(ctx);
			return result;
		}
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
			becomeCapturedRuntimeInert(error, ctx);
			return result;
		}
	};
	const finalizeBeforeAgentStart = (
		args: readonly unknown[],
		result: unknown,
		rawCtx: unknown,
	): unknown => {
		const ctx = rawCtx as ExtensionContext;
		lastContext = ctx;
		if (hasCompetingOwner(pi.getAllTools().map((tool) => tool.name))) {
			becomeCompetingOwnerInert(ctx);
			return result;
		}
		if (!hasActiveCatalog() || presentation === "native") {
			if (inertMessage) reportInert(ctx);
			return result;
		}
		let sdkPrompt: string;
		try {
			const sdkCatalog = catalog?.snapshot();
			if (!sdkCatalog) return result;
			sdkPrompt = renderSdkPrompt(sdkCatalog);
		} catch (error) {
			becomeCapturedRuntimeInert(error, ctx);
			return result;
		}
		const aggregate = isRecord(result) ? (result as AggregatedBeforeAgentStartResult) : undefined;
		const originalSystemPrompt = args[BEFORE_AGENT_START_SYSTEM_PROMPT_ARGUMENT_INDEX];
		const effectiveSystemPrompt =
			typeof aggregate?.systemPrompt === "string"
				? aggregate.systemPrompt
				: typeof originalSystemPrompt === "string"
					? originalSystemPrompt
					: "";
		let systemPrompt = `${effectiveSystemPrompt}\n\n${sdkPrompt}`;
		if (presentation === "code") {
			const options = args[BEFORE_AGENT_START_OPTIONS_ARGUMENT_INDEX] as
				| { skills?: SkillPromptInput[] }
				| undefined;
			systemPrompt += renderSkillsPrompt(options?.skills ?? []);
		}
		return aggregate ? { ...aggregate, systemPrompt } : { systemPrompt };
	};
	const runtimeInstaller: PiRuntimeInstaller = {
		capturePiRuntime(capture) {
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
			const registered = pi.getAllTools().map((tool) => tool.name);
			if (hasCompetingOwner(registered)) {
				becomeRuntimeInert(COMPETING_OWNER_MESSAGE, lastContext);
				return;
			}
			inertMessage = undefined;
			reportedInertMessage = undefined;
			try {
				catalog = createToolCatalog({
					session: capture.session,
					getPresentation: () => presentation,
					onRefreshFailure: (failure) => {
						becomeRefreshFailureInert(failure, lastContext);
					},
				});
				eventFinalizers = capture.session.installRuntimeEventFinalizers({
					finalizeToolCall,
					finalizeBeforeAgentStart,
				});
				capturedSession = capture.session;
			} catch (error) {
				becomeCapturedRuntimeInert(error, lastContext);
				return;
			}
			captureReadiness = "active";
			if (lastContext) apply(lastContext);
		},
	};
	const patchInstallation = installRuntimeCapture(runtimeInstaller);
	if (!patchInstallation.compatible) {
		captureReadiness = "inert";
		inertMessage = patchInstallation.diagnostic;
	}

	if (patchInstallation.compatible) {
		transportTool = createPtcTool({
			timeoutMs: shipped.timeoutMs,
			drainTimeoutMs: shipped.drainTimeoutMs,
			maxOrphanedBindings: shipped.maxOrphanedBindings,
			maxDispatches: shipped.maxDispatches,
			maxRenderDetailsBytes: shipped.maxRenderDetailsBytes,
			maxPersistedDetailsBytes: shipped.maxPersistedDetailsBytes,
			maxOutputBytes: shipped.maxOutputBytes,
			maxOutputLines: shipped.maxOutputLines,
			failureDetails,
			createExecution: (ctx) => {
				const executionCatalog = catalog;
				const executionSession = capturedSession;
				if (!hasActiveCatalog() || !executionCatalog || !executionSession) {
					if (captureReadiness === "pending" && lastContext) {
						becomeMissingCaptureInert(lastContext);
					}
					throw new Error(PTC_RUNTIME_UNAVAILABLE_MESSAGE);
				}
				let snapshot: ReturnType<ToolCatalog["snapshot"]>;
				try {
					snapshot = executionCatalog.snapshot();
				} catch (error) {
					becomeCapturedRuntimeInert(error, lastContext);
					throw new Error(PTC_RUNTIME_UNAVAILABLE_MESSAGE);
				}
				try {
					const executor = createToolExecutor({
						catalog: snapshot,
						session: executionSession,
						activateTools(names) {
							if (
								catalog !== executionCatalog ||
								capturedSession !== executionSession ||
								!hasActiveCatalog()
							) {
								return;
							}
							try {
								const additions = [
									...new Set(
										names.filter(
											(name): name is string => typeof name === "string" && name !== TRANSPORT_NAME,
										),
									),
								];
								const logical = executionCatalog.getLogicalActiveTools();
								executionSession.sharedRuntime.setActiveTools([...logical, ...additions]);
							} catch (error) {
								becomeCapturedRuntimeInert(error, lastContext);
								throw new Error(PTC_RUNTIME_UNAVAILABLE_MESSAGE);
							}
						},
					});
					return {
						definitions: createPtcDefinitionRegistry(snapshot),
						bindings: createToolBindings(
							snapshot,
							executor,
							createScheduler(shipped.maxParallelDispatches),
							{
								acceptSideEffects: ctx.isOpen,
								appendLog: (entry: DispatchLogEntry) => {
									pi.appendEntry(DISPATCH_LOG_TYPE, entry);
								},
								emit: (name, payload) => {
									pi.events.emit(name, payload);
								},
								reportDispatch: ctx.reportDispatch,
							},
						),
					};
				} catch (error) {
					becomeCapturedRuntimeInert(error, lastContext);
					throw new Error(PTC_RUNTIME_UNAVAILABLE_MESSAGE);
				}
			},
		});
		const definition = tagPtcToolDefinition(transportTool, runtimeInstaller);
		pi.registerTool(definition);
	}

	pi.registerCommand("ptc", {
		description: "Set PTC presentation: on, both, or off",
		handler: (args: string, ctx: ExtensionContext) => {
			if (!requireActiveCatalog(ctx)) return;
			const parsed = parsePresentationArg(args);
			if (!parsed) {
				ctx.ui.notify(PTC_COMMAND_USAGE, "error");
				return;
			}
			presentation = parsed === "cycle" ? cyclePresentation(presentation) : parsed;
			const paths = resolvePaths(ctx.cwd);
			savePresentation(ctx.isProjectTrusted() ? paths.projectFile : paths.userFile, presentation);
			apply(ctx);
		},
	});

	pi.on("session_start", (_event, rawCtx) => {
		const ctx = rawCtx as ExtensionContext;
		lastContext = ctx;
		const paths = resolvePaths(ctx.cwd);
		presentation = loadPresentation({
			projectFile: ctx.isProjectTrusted() ? paths.projectFile : undefined,
			userFile: paths.userFile,
			fallback: shipped.presentation,
		});
		const registered = pi.getAllTools().map((tool) => tool.name);
		if (hasCompetingOwner(registered)) {
			becomeCompetingOwnerInert(ctx);
			return;
		}
		if (inertMessage) {
			reportInert(ctx);
			return;
		}
		if (captureReadiness === "pending") return;
		apply(ctx);
	});

	pi.on("turn_start", (_event, rawCtx) => {
		const ctx = rawCtx as ExtensionContext;
		if (!requireActiveCatalog(ctx)) return;
		apply(ctx);
	});

	pi.on("tool_result", (rawEvent) => {
		const event = rawEvent as { toolCallId?: string; toolName?: string };
		if (event.toolName !== TRANSPORT_NAME || typeof event.toolCallId !== "string") return;
		const details = failureDetails.consume(event.toolCallId);
		return details === undefined ? undefined : { details };
	});

	pi.on("session_shutdown", () => {
		failureDetails.clear();
		transportTool?.clearRenderSnapshots();
		restoreControlledRuntime();
		if (patchInstallation.compatible) {
			captureReadiness = "pending";
			inertMessage = undefined;
			reportedInertMessage = undefined;
		}
		lastContext = undefined;
	});

	pi.on("tool_call", (_rawEvent, rawCtx) => {
		markRuntimeEventReadiness(rawCtx as ExtensionContext);
		return undefined;
	});

	pi.on("before_agent_start", (_rawEvent, rawCtx) => {
		markRuntimeEventReadiness(rawCtx as ExtensionContext);
		return undefined;
	});
}
