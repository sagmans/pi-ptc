import { join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	loadMaxDispatches,
	SETTINGS_FILE_NAME,
	SHIPPED_PTC_CONFIG,
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

function installDefaultRuntimeCapture(): PiRuntimeSharedPatchEnsure {
	return ensureSharedPiRuntimeCapturePatch();
}

export function defaultPathResolver(cwd: string): { projectFile: string; userFile: string } {
	return {
		projectFile: join(cwd, CONFIG_DIR_NAME, SETTINGS_FILE_NAME),
		userFile: join(getAgentDir(), SETTINGS_FILE_NAME),
	};
}

export default function installPtc(pi: ExtensionAPI, options: InstallPtcOptions = {}): void {
	const resolvePaths = options.resolvePaths ?? defaultPathResolver;
	const installRuntimeCapture = options.installRuntimeCapture ?? installDefaultRuntimeCapture;
	const shipped = SHIPPED_PTC_CONFIG;
	const failureDetails = createFailureDetailsStore();
	let maxDispatches = shipped.maxDispatches;
	let transportTool: ReturnType<typeof createPtcTool> | undefined;
	const lifecycle = createPtcLifecycle({
		pi,
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
			drainTimeoutMs: shipped.drainTimeoutMs,
			get maxDispatches() {
				return maxDispatches;
			},
			maxRenderDetailsBytes: shipped.maxRenderDetailsBytes,
			maxPersistedDetailsBytes: shipped.maxPersistedDetailsBytes,
			maxOutputBytes: shipped.maxOutputBytes,
			maxOutputLines: shipped.maxOutputLines,
			createExecution: (context) => lifecycle.createExecution(context),
		});
		pi.registerTool(tagPtcToolDefinition(transportTool, runtimeInstaller));
	}

	pi.on("session_start", (_event, rawContext) => {
		const context = rawContext as ExtensionContext;
		const paths = resolvePaths(context.cwd);
		maxDispatches = loadMaxDispatches({
			projectFile: context.isProjectTrusted() ? paths.projectFile : undefined,
			userFile: paths.userFile,
			fallback: shipped.maxDispatches,
		});
		lifecycle.sessionStart(context);
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
