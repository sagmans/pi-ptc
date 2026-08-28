import { join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import { createCoreBindings, createOfficialExecutor, type DispatchLogEntry } from "./bridge.ts";
import {
	COMPETING_OWNER_MESSAGE,
	cyclePresentation,
	DISPATCH_LOG_TYPE,
	isCoreToolName,
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
import type { ExtensionAPI, ExtensionContext } from "./host.ts";
import {
	ensureSharedPiRuntimeCapturePatch,
	type PiRuntimeEventFinalizersInstallation,
	type PiRuntimeInstaller,
	type PiRuntimePatchInstallation,
	type PiRuntimeSharedPatchEnsure,
	tagPtcToolDefinition,
} from "./pi-runtime.ts";
import { hasCompetingOwner } from "./presentation.ts";
import { createScheduler } from "./scheduler.ts";
import { renderSdkPrompt, renderSkillsPrompt, type SkillPromptInput } from "./sdk.ts";
import { createToolCatalog, type ToolCatalog } from "./tool-catalog.ts";
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
	let eventFinalizers: PiRuntimeEventFinalizersInstallation | undefined;
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
	const restoreCatalog = (): void => {
		if (!catalog) return;
		try {
			catalog.restore();
		} finally {
			catalog = undefined;
		}
	};
	const restoreEventFinalizers = (): void => {
		if (!eventFinalizers) return;
		try {
			eventFinalizers.restore();
		} finally {
			eventFinalizers = undefined;
		}
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
		captureReadiness === "active" && catalog !== undefined && inertMessage === undefined;
	const becomeCompetingOwnerInert = (ctx: ExtensionContext): void => {
		restoreControlledRuntime();
		captureReadiness = "inert";
		inertMessage = COMPETING_OWNER_MESSAGE;
		reportInert(ctx);
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
		const resolved = activeCatalog.applyPhysical();
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
		if (isBlockingToolCallResult(result) || presentation !== "code") return result;
		const event = args[TOOL_CALL_EVENT_ARGUMENT_INDEX] as { toolName?: unknown } | undefined;
		return typeof event?.toolName === "string" && isCoreToolName(event.toolName)
			? { block: true, reason: LEAK_BLOCK_REASON }
			: result;
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
		const aggregate = isRecord(result) ? (result as AggregatedBeforeAgentStartResult) : undefined;
		const originalSystemPrompt = args[BEFORE_AGENT_START_SYSTEM_PROMPT_ARGUMENT_INDEX];
		const effectiveSystemPrompt =
			typeof aggregate?.systemPrompt === "string"
				? aggregate.systemPrompt
				: typeof originalSystemPrompt === "string"
					? originalSystemPrompt
					: "";
		let systemPrompt = `${effectiveSystemPrompt}\n\n${renderSdkPrompt()}`;
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
			restoreControlledRuntime();
			captureReadiness = "pending";
			if (!capture.compatible) {
				captureReadiness = "inert";
				inertMessage = capture.diagnostic;
				if (lastContext) reportInert(lastContext);
				return;
			}
			const registered = pi.getAllTools().map((tool) => tool.name);
			if (hasCompetingOwner(registered)) {
				captureReadiness = "inert";
				inertMessage = COMPETING_OWNER_MESSAGE;
				if (lastContext) reportInert(lastContext);
				return;
			}
			inertMessage = undefined;
			reportedInertMessage = undefined;
			try {
				catalog = createToolCatalog({
					session: capture.session,
					getPresentation: () => presentation,
				});
				eventFinalizers = capture.session.installRuntimeEventFinalizers({
					finalizeToolCall,
					finalizeBeforeAgentStart,
				});
			} catch (error) {
				restoreControlledRuntime();
				captureReadiness = "inert";
				inertMessage = `${RUNTIME_INCOMPATIBILITY_PREFIX}: ${
					error instanceof Error ? error.message : String(error)
				}`;
				if (lastContext) reportInert(lastContext);
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
		const definition = tagPtcToolDefinition(
			createPtcTool({
				timeoutMs: shipped.timeoutMs,
				drainTimeoutMs: shipped.drainTimeoutMs,
				maxOrphanedBindings: shipped.maxOrphanedBindings,
				maxDispatches: shipped.maxDispatches,
				maxRenderDetailsBytes: shipped.maxRenderDetailsBytes,
				maxPersistedDetailsBytes: shipped.maxPersistedDetailsBytes,
				maxOutputBytes: shipped.maxOutputBytes,
				maxOutputLines: shipped.maxOutputLines,
				failureDetails,
				createBindings: (ctx) =>
					createCoreBindings({
						execute: createOfficialExecutor(ctx.cwd),
						scheduler: createScheduler(shipped.maxParallelDispatches),
						acceptSideEffects: ctx.isOpen,
						appendLog: (entry: DispatchLogEntry) => {
							pi.appendEntry(DISPATCH_LOG_TYPE, entry);
						},
						emit: (name, payload) => {
							pi.events.emit(name, payload);
						},
						reportDispatch: ctx.reportDispatch,
					}),
			}),
			runtimeInstaller,
		);
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
