import { join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	cyclePresentation,
	loadPresentation,
	PRESENTATION_FILE_NAME,
	parsePresentationArg,
	SHIPPED_PTC_CONFIG,
	savePresentation,
	TRANSPORT_NAME,
} from "./config.ts";
import type { ExtensionAPI, ExtensionContext } from "./host.ts";
import {
	ensureSharedPiRuntimeCapturePatch,
	type PiRuntimeInstaller,
	type PiRuntimePatchInstallation,
	type PiRuntimeSharedPatchEnsure,
	tagPtcToolDefinition,
} from "./pi-runtime.ts";
import { createPtcLifecycle } from "./ptc-lifecycle.ts";
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

function installDefaultRuntimeCapture(): PiRuntimeSharedPatchEnsure {
	return ensureSharedPiRuntimeCapturePatch();
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
	const failureDetails = createFailureDetailsStore();
	let transportTool: ReturnType<typeof createPtcTool> | undefined;
	const lifecycle = createPtcLifecycle({
		pi,
		initialPresentation: shipped.presentation,
		maxParallelDispatches: shipped.maxParallelDispatches,
		failureDetails,
		clearRenderSnapshots() {
			transportTool?.clearRenderSnapshots();
		},
	});
	const runtimeInstaller: PiRuntimeInstaller = {
		capturePiRuntime(capture) {
			lifecycle.capture(capture);
		},
	};
	const patchInstallation = installRuntimeCapture(runtimeInstaller);
	if (!patchInstallation.compatible) {
		lifecycle.capture({ compatible: false, diagnostic: patchInstallation.diagnostic });
	} else {
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
			createExecution: (context) => lifecycle.createExecution(context),
		});
		pi.registerTool(tagPtcToolDefinition(transportTool, runtimeInstaller));
	}

	pi.registerCommand("ptc", {
		description: "Set PTC presentation: on, both, or off",
		handler: (args: string, context: ExtensionContext) => {
			if (!lifecycle.requireActive(context)) return;
			const parsed = parsePresentationArg(args);
			if (!parsed) {
				context.ui.notify(PTC_COMMAND_USAGE, "error");
				return;
			}
			const presentation = parsed === "cycle" ? cyclePresentation(lifecycle.presentation) : parsed;
			lifecycle.setPresentation(presentation);
			const paths = resolvePaths(context.cwd);
			savePresentation(
				context.isProjectTrusted() ? paths.projectFile : paths.userFile,
				presentation,
			);
			lifecycle.apply(context);
		},
	});

	pi.on("session_start", (_event, rawContext) => {
		const context = rawContext as ExtensionContext;
		const paths = resolvePaths(context.cwd);
		const presentation = loadPresentation({
			projectFile: context.isProjectTrusted() ? paths.projectFile : undefined,
			userFile: paths.userFile,
			fallback: shipped.presentation,
		});
		lifecycle.sessionStart(context, presentation);
	});
	pi.on("turn_start", (_event, rawContext) => {
		const context = rawContext as ExtensionContext;
		if (lifecycle.requireActive(context)) lifecycle.apply(context);
	});
	pi.on("tool_result", (rawEvent) => {
		const event = rawEvent as { toolCallId?: string; toolName?: string };
		if (event.toolName !== TRANSPORT_NAME || typeof event.toolCallId !== "string") return;
		const details = lifecycle.consumeFailure(event.toolCallId);
		return details === undefined ? undefined : { details };
	});
	pi.on("session_shutdown", () => lifecycle.clear("shutdown"));
	pi.on("tool_call", (_event, rawContext) => {
		lifecycle.markRuntimeEventReadiness(rawContext as ExtensionContext);
		return undefined;
	});
	pi.on("before_agent_start", (_event, rawContext) => {
		lifecycle.markRuntimeEventReadiness(rawContext as ExtensionContext);
		return undefined;
	});
}
