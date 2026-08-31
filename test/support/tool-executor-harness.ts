import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Type } from "typebox";
import {
	type CapturedPiSession,
	type PiRuntimeActionsInstallation,
	type PiRuntimeEventFinalizersInstallation,
	type PiRuntimeTool,
	SUPPORTED_PI_VERSION,
} from "../../src/pi-runtime.ts";
import { createPiToolArgumentPreparer } from "../../src/pi-runtime-arguments.ts";
import type { ToolCatalogEntry } from "../../src/tool-catalog.ts";

export const TOOL_NAME = "demo";
export const OTHER_TOOL_NAME = "other";
export const OPERATION_ABORTED_MESSAGE = "Operation aborted";
export const ZERO_USAGE = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

export type RuntimeEvent = Record<string, unknown> & { type: string };
export type HookContext = {
	assistantMessage: Record<string, unknown> & { content: unknown[] };
	toolCall: Record<string, unknown> & {
		type: "toolCall";
		id: string;
		name: string;
		arguments: unknown;
	};
	args: unknown;
	context: {
		systemPrompt: string;
		messages: unknown[];
		tools: Array<PiRuntimeTool & { name: string; label: string; description: string }>;
	};
	result?: Record<string, unknown>;
	isError?: boolean;
};

export type SessionOptions = {
	argumentTools?: readonly ToolCatalogEntry[];
	emit?: (event: RuntimeEvent) => Promise<unknown> | unknown;
	beforeToolCall?: (context: HookContext, signal?: AbortSignal) => Promise<unknown> | unknown;
	afterToolCall?: (context: HookContext, signal?: AbortSignal) => Promise<unknown> | unknown;
};

export type EntryOptions = {
	name?: string;
	parameters?: object;
	prepareArguments?: (args: unknown) => unknown;
	executionMode?: "parallel" | "sequential";
	execute?: PiRuntimeTool["execute"];
};

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function asEvent(value: unknown): RuntimeEvent {
	assert.equal(isRecord(value), true);
	assert.equal(typeof (value as Record<string, unknown>).type, "string");
	return value as RuntimeEvent;
}

export function createSession(options: SessionOptions = {}): CapturedPiSession {
	const argumentTools = new Map(
		(options.argumentTools ?? []).map((entry) => [entry.name, entry.executable]),
	);
	const prepareToolArguments = options.argumentTools
		? createPiToolArgumentPreparer(argumentTools)
		: (_toolName: string, rawArguments: unknown) => ({ ok: true, value: rawArguments }) as const;
	return {
		version: SUPPORTED_PI_VERSION,
		extensionRunner: {
			createContext: () => ({ cwd: "/tmp" }),
			emit: async (event) => options.emit?.(asEvent(event)),
		},
		sharedRuntime: {
			getActiveTools: () => [],
			setActiveTools() {},
			refreshTools() {},
		},
		toolRegistry: new Map(),
		beforeToolCall: async (...args: unknown[]) =>
			options.beforeToolCall?.(args[0] as HookContext, args[1] as AbortSignal | undefined),
		afterToolCall: async (...args: unknown[]) =>
			options.afterToolCall?.(args[0] as HookContext, args[1] as AbortSignal | undefined),
		getToolDefinition: () => undefined,
		prepareToolArguments,
		installRuntimeActions(): PiRuntimeActionsInstallation {
			throw new Error("not used by tool executor tests");
		},
		installRuntimeEventFinalizers(): PiRuntimeEventFinalizersInstallation {
			throw new Error("not used by tool executor tests");
		},
	};
}

export function createEntry(options: EntryOptions = {}): ToolCatalogEntry {
	const executable: PiRuntimeTool = {
		parameters: options.parameters ?? Type.Object({}),
		...(options.prepareArguments ? { prepareArguments: options.prepareArguments } : {}),
		...(options.executionMode ? { executionMode: options.executionMode } : {}),
		execute:
			options.execute ?? (async () => ({ content: [{ type: "text", text: "ok" }], details: {} })),
	};
	const name = options.name ?? TOOL_NAME;
	return { name, executable, definition: { name } };
}

export function resultText(result: { content?: unknown }): string | undefined {
	if (!Array.isArray(result.content)) return undefined;
	const first = result.content[0];
	return isRecord(first) && typeof first.text === "string" ? first.text : undefined;
}

export function immediate(): Promise<void> {
	return new Promise((resolveImmediate) => setImmediate(resolveImmediate));
}

export async function loadNativeValidation(): Promise<{
	validateToolArguments(
		tool: PiRuntimeTool & { name: string },
		toolCall: HookContext["toolCall"],
	): unknown;
}> {
	const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const validationPath = resolve(
		dirname(codingAgentEntry),
		"../node_modules/@earendil-works/pi-ai/dist/utils/validation.js",
	);
	return (await import(pathToFileURL(validationPath).href)) as {
		validateToolArguments(
			tool: PiRuntimeTool & { name: string },
			toolCall: HookContext["toolCall"],
		): unknown;
	};
}
