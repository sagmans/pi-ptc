// Session installer. Presentation is re-asserted each turn so later owners cannot drift it.

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
import { applyPresentation, hasCompetingOwner, resolveActiveTools } from "./presentation.ts";
import { createScheduler } from "./scheduler.ts";
import { renderSdkPrompt, renderSkillsPrompt, type SkillPromptInput } from "./sdk.ts";
import { createPtcTool } from "./transport.ts";

export type PathResolver = (cwd: string) => { projectFile: string; userFile: string };

export type InstallPtcOptions = {
	resolvePaths?: PathResolver;
};

const PTC_COMMAND_USAGE = "Usage: /ptc [on|both|off]";

export function defaultPathResolver(cwd: string): { projectFile: string; userFile: string } {
	return {
		projectFile: join(cwd, CONFIG_DIR_NAME, PRESENTATION_FILE_NAME),
		userFile: join(getAgentDir(), PRESENTATION_FILE_NAME),
	};
}

export default function installPtc(pi: ExtensionAPI, options: InstallPtcOptions = {}): void {
	const resolvePaths = options.resolvePaths ?? defaultPathResolver;
	const shipped = SHIPPED_PTC_CONFIG;
	let recorded: string[] = [];
	let presentation: Presentation = shipped.presentation;
	let inert = false;

	const apply = (ctx: ExtensionContext): void => {
		if (inert) return;
		const registered = pi.getAllTools().map((tool) => tool.name);
		const resolved = resolveActiveTools({
			presentation,
			recorded,
			registered,
		});
		if (resolved.missingTransport) {
			presentation = "native";
			ctx.ui.notify(MISSING_TRANSPORT_MESSAGE, "warning");
		}
		pi.setActiveTools(resolved.tools);
		ctx.ui.setStatus(STATUS_KEY, `ptc: ${presentation}`);
	};

	pi.registerTool(
		createPtcTool({
			timeoutMs: shipped.timeoutMs,
			maxOutputBytes: shipped.maxOutputBytes,
			maxOutputLines: shipped.maxOutputLines,
			createBindings: (ctx) =>
				createCoreBindings({
					execute: createOfficialExecutor(ctx.cwd, ctx.signal),
					scheduler: createScheduler(shipped.maxParallelDispatches),
					signal: ctx.signal,
					appendLog: (entry: DispatchLogEntry) => {
						pi.appendEntry(DISPATCH_LOG_TYPE, entry);
					},
					emit: (name, payload) => {
						pi.events.emit(name, payload);
					},
					reportDispatch: ctx.reportDispatch,
				}),
		}),
	);

	pi.registerCommand("ptc", {
		description: "Set PTC presentation: on, both, or off",
		handler: (args: string, ctx: ExtensionContext) => {
			if (inert) {
				ctx.ui.notify(COMPETING_OWNER_MESSAGE, "warning");
				return;
			}
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
		const registered = pi.getAllTools().map((tool) => tool.name);
		if (hasCompetingOwner(registered)) {
			inert = true;
			ctx.ui.notify(COMPETING_OWNER_MESSAGE, "warning");
			return;
		}
		const paths = resolvePaths(ctx.cwd);
		presentation = loadPresentation({
			projectFile: ctx.isProjectTrusted() ? paths.projectFile : undefined,
			userFile: paths.userFile,
			fallback: shipped.presentation,
		});
		recorded = pi.getActiveTools().filter((name) => name !== TRANSPORT_NAME);
		if (recorded.length === 0) {
			recorded = applyPresentation({ presentation: "native", recorded: registered });
		}
		apply(ctx);
	});

	pi.on("turn_start", (_event, rawCtx) => {
		apply(rawCtx as ExtensionContext);
	});

	pi.on("tool_call", (rawEvent) => {
		if (inert || presentation !== "code") return;
		const event = rawEvent as { toolName?: string };
		if (typeof event.toolName === "string" && isCoreToolName(event.toolName)) {
			return { block: true, reason: LEAK_BLOCK_REASON };
		}
		return undefined;
	});

	pi.on("before_agent_start", (rawEvent) => {
		if (inert || presentation === "native") return;
		const event = rawEvent as {
			systemPrompt?: string;
			systemPromptOptions?: { skills?: SkillPromptInput[] };
		};
		let systemPrompt = `${event.systemPrompt ?? ""}\n\n${renderSdkPrompt()}`;
		if (presentation === "code") {
			systemPrompt += renderSkillsPrompt(event.systemPromptOptions?.skills ?? []);
		}
		return { systemPrompt };
	});
}
