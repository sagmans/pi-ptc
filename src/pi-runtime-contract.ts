import {
	type SupportedPiVersion,
	UNSUPPORTED_PI_VERSION_DIAGNOSTIC,
} from "./pi-runtime-version.ts";

export const PI_RUNTIME_PRIVATE_PROPERTIES = Object.freeze({
	TOOL_REGISTRY: "_toolRegistry",
	RUNNER_RUNTIME: "runtime",
});

export const PI_RUNTIME_DIAGNOSTICS = Object.freeze({
	UNSUPPORTED_VERSION: UNSUPPORTED_PI_VERSION_DIAGNOSTIC,
	MISSING_BIND_EXTENSIONS: "AgentSession.prototype.bindExtensions is unavailable",
	UNPATCHABLE_BIND_EXTENSIONS: "AgentSession.prototype.bindExtensions is not patchable",
	MISSING_RELOAD: "AgentSession.prototype.reload is unavailable",
	UNPATCHABLE_RELOAD: "AgentSession.prototype.reload is not patchable",
	PATCH_CONFLICT: "AgentSession lifecycle methods changed after pi-ptc patched them",
	PATCH_FAILED: "AgentSession lifecycle methods could not be patched",
	INVALID_INSTALLER: "Pi runtime installer must implement capturePiRuntime",
	MISSING_TOOL_LOOKUP: "Bound AgentSession.getToolDefinition is unavailable",
	MISSING_EXTENSION_RUNNER: "Bound AgentSession.extensionRunner is unavailable",
	MISSING_CREATE_CONTEXT: "Bound extensionRunner.createContext is unavailable",
	MISSING_EMIT: "Bound extensionRunner.emit is unavailable",
	MISSING_EMIT_TOOL_CALL: "Bound extensionRunner.emitToolCall is unavailable",
	UNPATCHABLE_EMIT_TOOL_CALL: "Bound extensionRunner.emitToolCall is not patchable",
	MISSING_EMIT_BEFORE_AGENT_START: "Bound extensionRunner.emitBeforeAgentStart is unavailable",
	UNPATCHABLE_EMIT_BEFORE_AGENT_START:
		"Bound extensionRunner.emitBeforeAgentStart is not patchable",
	MISSING_RUNNER_RUNTIME: "Bound extensionRunner runtime is unavailable",
	MISSING_GET_ACTIVE_TOOLS: "Bound extension runtime getActiveTools is unavailable",
	MISSING_SET_ACTIVE_TOOLS: "Bound extension runtime setActiveTools is unavailable",
	MISSING_REFRESH_TOOLS: "Bound extension runtime refreshTools is unavailable",
	INVALID_RUNTIME_ACTION_REPLACEMENTS: "Pi runtime action replacements are invalid",
	UNPATCHABLE_RUNTIME_ACTIONS: "Bound extension runtime actions are not patchable",
	RUNTIME_ACTION_PATCH_FAILED: "Bound extension runtime actions could not be replaced",
	RUNTIME_ACTIONS_ALREADY_INSTALLED: "Pi runtime actions are already virtualized",
	INVALID_RUNTIME_EVENT_FINALIZERS: "Pi runtime event finalizers are invalid",
	RUNTIME_EVENT_FINALIZERS_ALREADY_INSTALLED: "Pi runtime event finalizers are already installed",
	RUNTIME_EVENT_FINALIZER_PATCH_FAILED:
		"Bound extension runner event finalizers could not be installed",
	MISSING_TOOL_REGISTRY: "Bound AgentSession._toolRegistry is unavailable",
	INVALID_TOOL_NAME: "Bound tool registry contains an invalid name",
	MISSING_TOOL_PARAMETERS: "Bound tool registry entry parameters are unavailable",
	INVALID_PREPARE_ARGUMENTS: "Bound tool registry entry prepareArguments is invalid",
	INVALID_EXECUTION_MODE: "Bound tool registry entry executionMode is invalid",
	MISSING_TOOL_EXECUTE: "Bound tool registry entry execute is unavailable",
	MISSING_AGENT: "Bound AgentSession.agent is unavailable",
	MISSING_BEFORE_TOOL_CALL: "Bound agent.beforeToolCall hook is unavailable",
	MISSING_AFTER_TOOL_CALL: "Bound agent.afterToolCall hook is unavailable",
	GLOBAL_REGISTRY: "Pi runtime global registry is unavailable",
	TRANSPORT_OWNERSHIP_CHECK_FAILED: "Owned ptc transport could not be verified",
	STALE_CAPTURE: "Captured Pi runtime session is no longer associated with this installer",
} as const);

export type PiRuntimeTool = {
	parameters: object;
	prepareArguments?: (args: unknown) => unknown;
	executionMode?: "parallel" | "sequential";
	execute(
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: (partialResult: unknown) => void,
	): Promise<unknown>;
};
export type PiExtensionRunner = {
	createContext(): unknown;
	emit(event: unknown): Promise<unknown>;
};
export type PiRuntimeEventFinalizer = (
	args: readonly unknown[],
	result: unknown,
	context: unknown,
) => Promise<unknown> | unknown;

export type PiRuntimeEventFinalizers = {
	finalizeToolCall: PiRuntimeEventFinalizer;
	finalizeBeforeAgentStart: PiRuntimeEventFinalizer;
};
export type PiRuntimeEventFinalizersInstallation = {
	restore(): void;
};

export type PiSharedRuntime = {
	getActiveTools(): string[];
	setActiveTools(toolNames: string[]): void;
	refreshTools(): void;
};

export type PiRuntimeToolEntry = {
	readonly name: string;
	readonly executable: PiRuntimeTool;
	readonly definition: unknown;
};
export type PiRuntimeOriginalActions = {
	getActiveTools(): string[];
	setActiveTools(toolNames: string[]): void;
	refreshTools(): void;
	snapshotTools(): readonly PiRuntimeToolEntry[];
};

export type PiRuntimeActionsInstallation = {
	readonly original: PiRuntimeOriginalActions;
	restore(activeToolNames?: readonly string[]): void;
};
export type PiToolArgumentPreparation =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly message: string };
export type CapturedPiSession = {
	readonly version: SupportedPiVersion;
	readonly extensionRunner: PiExtensionRunner;
	readonly sharedRuntime: PiSharedRuntime;
	readonly toolRegistry: ReadonlyMap<string, PiRuntimeTool>;
	readonly beforeToolCall: (...args: unknown[]) => Promise<unknown>;
	readonly afterToolCall: (...args: unknown[]) => Promise<unknown>;
	getToolDefinition(name: string): unknown;
	prepareToolArguments(
		toolName: string,
		rawArguments: unknown,
		tool?: PiRuntimeTool,
	): PiToolArgumentPreparation;
	installRuntimeActions(replacements: PiSharedRuntime): PiRuntimeActionsInstallation;
	installRuntimeEventFinalizers(
		finalizers: PiRuntimeEventFinalizers,
	): PiRuntimeEventFinalizersInstallation;
};

export type PtcTransportOwnership = {
	isCurrent(): boolean;
};

export type PiRuntimeCapture =
	| {
			compatible: true;
			session: CapturedPiSession;
			transportOwnership?: PtcTransportOwnership;
	  }
	| {
			compatible: false;
			diagnostic: string;
			transportOwnership?: PtcTransportOwnership;
	  };

export type PiRuntimeInstaller = {
	capturePiRuntime(capture: PiRuntimeCapture): void;
};

export type PiRuntimePatchOptions = {
	agentSession?: { prototype: object };
	version?: string;
	globalObject?: object;
};

export type PiRuntimePatchInstallation =
	| { compatible: true; teardown: () => void }
	| { compatible: false; diagnostic: string };

export type PiRuntimeSharedPatchEnsure =
	| { compatible: true }
	| { compatible: false; diagnostic: string };

export function diagnostic(prefix: string, detail?: string): string {
	return detail ? `${prefix}: ${detail}` : prefix;
}
