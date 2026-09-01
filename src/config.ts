// Shipped defaults live in config.json so tunables are not hardcoded in source.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SHIPPED_CONFIG_PATH = fileURLToPath(new URL("../config.json", import.meta.url));

export const TRANSPORT_NAME = "ptc";
export const PROGRAM_WRAPPER_NAME = "__ptc_main__";
export const DISPATCH_EVENT = "pi-ptc:dispatch";
export const DISPATCH_LOG_TYPE = "ptc-dispatch";
export const PRESENTATION_FILE_NAME = "ptc.json";
export const STATUS_KEY = "ptc";
export const LEAK_BLOCK_REASON =
	"only `ptc` may call active runtime tools — use tools.<name>(args) inside a ptc program";
export const COMPETING_OWNER_MESSAGE =
	"pi-ptc staying inert: another code-mode owner is already registered";
export const MISSING_TRANSPORT_MESSAGE =
	"pi-ptc restored native active runtime tools because the ptc transport is missing";
export const TRUST_COPY =
	"bash-equivalent containment, not a sandbox. Treat the program as user-equivalent peer code.";
export const EMPTY_DESCRIPTION_MESSAGE = "description must be non-empty";
export const STRIP_UNAVAILABLE_MESSAGE = "no TypeScript stripper available";
export const TYPESCRIPT_LOADER = "ts";

export const CORE_TOOL_NAMES = Object.freeze([
	"bash",
	"edit",
	"find",
	"grep",
	"ls",
	"read",
	"write",
] as const);

export const EXCLUSIVE_TOOL_NAMES = Object.freeze(["bash", "edit", "write"] as const);

export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];
export type Presentation = "code" | "both" | "native";

export type PtcConfig = {
	readonly presentation: Presentation;
	readonly timeoutMs: number;
	readonly drainTimeoutMs: number;
	readonly maxOrphanedBindings: number;
	readonly maxParallelDispatches: number;
	readonly maxDispatches: number;
	readonly maxToolUpdatesPerDispatch: number;
	readonly maxRenderDetailsBytes: number;
	readonly maxPersistedDetailsBytes: number;
	readonly maxOutputBytes: number;
	readonly maxOutputLines: number;
	readonly workerMaxOldGenerationSizeMb: number;
};

const PRESENTATIONS = new Set<Presentation>(["code", "both", "native"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredPositiveInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`invalid pi-ptc config: ${field} must be a positive integer`);
	}
	return value;
}

function parseShippedConfig(value: unknown): PtcConfig {
	if (!isRecord(value)) throw new Error("invalid pi-ptc config: shipped root must be an object");
	if (
		typeof value.presentation !== "string" ||
		!PRESENTATIONS.has(value.presentation as Presentation)
	) {
		throw new Error("invalid pi-ptc config: presentation must be code, both, or native");
	}
	return {
		presentation: value.presentation as Presentation,
		timeoutMs: requiredPositiveInteger(value.timeoutMs, "timeoutMs"),
		drainTimeoutMs: requiredPositiveInteger(value.drainTimeoutMs, "drainTimeoutMs"),
		maxOrphanedBindings: requiredPositiveInteger(value.maxOrphanedBindings, "maxOrphanedBindings"),
		maxParallelDispatches: requiredPositiveInteger(
			value.maxParallelDispatches,
			"maxParallelDispatches",
		),
		maxDispatches: requiredPositiveInteger(value.maxDispatches, "maxDispatches"),
		maxToolUpdatesPerDispatch: requiredPositiveInteger(
			value.maxToolUpdatesPerDispatch,
			"maxToolUpdatesPerDispatch",
		),
		maxRenderDetailsBytes: requiredPositiveInteger(
			value.maxRenderDetailsBytes,
			"maxRenderDetailsBytes",
		),
		maxPersistedDetailsBytes: requiredPositiveInteger(
			value.maxPersistedDetailsBytes,
			"maxPersistedDetailsBytes",
		),
		maxOutputBytes: requiredPositiveInteger(value.maxOutputBytes, "maxOutputBytes"),
		maxOutputLines: requiredPositiveInteger(value.maxOutputLines, "maxOutputLines"),
		workerMaxOldGenerationSizeMb: requiredPositiveInteger(
			value.workerMaxOldGenerationSizeMb,
			"workerMaxOldGenerationSizeMb",
		),
	};
}

export const SHIPPED_PTC_CONFIG: PtcConfig = Object.freeze(
	parseShippedConfig(JSON.parse(readFileSync(SHIPPED_CONFIG_PATH, "utf8"))),
);

export function isCoreToolName(name: string): name is CoreToolName {
	return (CORE_TOOL_NAMES as readonly string[]).includes(name);
}

export function isExclusiveToolName(name: string): boolean {
	return (EXCLUSIVE_TOOL_NAMES as readonly string[]).includes(name);
}

const PRESENTATION_CYCLE: readonly Presentation[] = ["code", "both", "native"];

export function cyclePresentation(current: Presentation): Presentation {
	const index = PRESENTATION_CYCLE.indexOf(current);
	return PRESENTATION_CYCLE[(index + 1) % PRESENTATION_CYCLE.length];
}

export function parsePresentationArg(arg: string): Presentation | "cycle" | undefined {
	const trimmed = arg.trim().toLowerCase();
	if (trimmed.length === 0) return "cycle";
	if (trimmed === "on" || trimmed === "code") return "code";
	if (trimmed === "both") return "both";
	if (trimmed === "off" || trimmed === "native") return "native";
	return undefined;
}

function readPresentationFile(file: string | undefined): Presentation | undefined {
	if (!file) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!isRecord(parsed)) return undefined;
		if (typeof parsed.presentation !== "string") return undefined;
		if (!PRESENTATIONS.has(parsed.presentation as Presentation)) return undefined;
		return parsed.presentation as Presentation;
	} catch {
		return undefined;
	}
}

export function loadPresentation(input: {
	projectFile?: string;
	userFile?: string;
	fallback: Presentation;
}): Presentation {
	return (
		readPresentationFile(input.projectFile) ??
		readPresentationFile(input.userFile) ??
		input.fallback
	);
}

export function savePresentation(file: string, presentation: Presentation): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ presentation }, null, "\t")}\n`);
}
