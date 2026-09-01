import { strict as assert } from "node:assert";
import { TRANSPORT_NAME } from "../../src/config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/host.ts";
import installPtc, { type InstallPtcOptions } from "../../src/index.ts";
import {
	type CapturedPiSession,
	type PiRuntimeActionsInstallation,
	type PiRuntimeEventFinalizers,
	type PiRuntimeEventFinalizersInstallation,
	type PiRuntimeInstaller,
	type PiRuntimeTool,
	SUPPORTED_PI_VERSION,
} from "../../src/pi-runtime.ts";
import { createPiToolArgumentPreparer } from "../../src/pi-runtime-arguments.ts";
import {
	type CommandHandler,
	type EventHandler,
	INERT_RUNTIME_DIAGNOSTIC,
	type RegisteredTool,
	tempPaths,
} from "./index-harness-shared.ts";

export type FakePiHarness = {
	pi: ExtensionAPI;
	tools: Map<string, RegisteredTool>;
	commands: Map<string, { handler: CommandHandler }>;
	handlers: Map<string, EventHandler>;
	notifications: string[];
	statuses: string[];
	ctx: ExtensionContext;
	installOptions: InstallPtcOptions;
	captureRuntime(): void;
	captureObsoleteRuntime(): void;
	captureIncompatible(diagnostic?: string, transportOwnership?: { isCurrent(): boolean }): void;
	physicalActive(): string[];
	physicalWriteCount(): number;
	registerRuntimeTool(name: string, executable?: PiRuntimeTool, definition?: object): void;
	emitToolCall(event: unknown, afterPtcHandler?: () => unknown): Promise<unknown>;
	emitBeforeAgentStart(
		prompt: string,
		options?: { skills?: unknown[] },
		afterPtcHandler?: () => unknown,
	): Promise<unknown>;
};

export function createExecutable(name: string): PiRuntimeTool {
	return {
		parameters: { type: "object", name },
		executionMode: "parallel",
		async execute() {
			return { content: [], details: { name } };
		},
	};
}

export type FakePiOptions = {
	shadowTransport?: boolean;
	beforeToolCall?: CapturedPiSession["beforeToolCall"];
	afterToolCall?: CapturedPiSession["afterToolCall"];
	setActiveToolsError?(names: readonly string[]): Error | undefined;
};

export function createFakePi(
	active: string[],
	available: string[] = active,
	options: FakePiOptions = {},
): FakePiHarness {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, { handler: CommandHandler }>();
	const handlers = new Map<string, EventHandler>();
	const notifications: string[] = [];
	const statuses: string[] = [];
	const definitions = new Map<string, object>();
	let registry = new Map<string, PiRuntimeTool>();
	const desiredRegistry = new Map<string, PiRuntimeTool>();
	let physical = [...active];
	let physicalWrites = 0;
	let runtimeBound = false;
	let captureInstaller: PiRuntimeInstaller | undefined;
	let operationActive = false;
	let eventFinalizers: PiRuntimeEventFinalizers | undefined;
	let eventFinalizersActive = false;

	for (const name of available) {
		const definition = { name };
		definitions.set(name, definition);
		const executable = createExecutable(name);
		registry.set(name, executable);
		desiredRegistry.set(name, executable);
	}

	const rawGetActiveTools = () => [...physical];
	const rawSetActiveTools = (names: string[]) => {
		physicalWrites += 1;
		const error = options.setActiveToolsError?.(names);
		if (error) throw error;
		physical = names.filter((name) => registry.has(name));
	};
	const rawRefreshTools = () => {
		const previousRegistryNames = new Set(registry.keys());
		const previousActiveNames = [...physical];
		registry = new Map(desiredRegistry);
		const nextActiveNames = previousActiveNames.filter((name) => registry.has(name));
		for (const name of registry.keys()) {
			if (!previousRegistryNames.has(name)) nextActiveNames.push(name);
		}
		physical = [...new Set(nextActiveNames)];
	};
	let actions = {
		getActiveTools: rawGetActiveTools,
		setActiveTools: rawSetActiveTools,
		refreshTools: rawRefreshTools,
	};

	const runtimeFacade = {
		getActiveTools: () => actions.getActiveTools(),
		setActiveTools: (names: string[]) => actions.setActiveTools(names),
		refreshTools: () => actions.refreshTools(),
	};
	const capturedSession: CapturedPiSession = {
		version: SUPPORTED_PI_VERSION,
		extensionRunner: {
			createContext: () => ({ cwd: "/tmp" }),
			emit: async () => undefined,
		},
		installRuntimeEventFinalizers(
			finalizers: PiRuntimeEventFinalizers,
		): PiRuntimeEventFinalizersInstallation {
			if (eventFinalizersActive) throw new Error("runtime event finalizers already installed");
			eventFinalizers = finalizers;
			eventFinalizersActive = true;
			let restored = false;
			return {
				restore() {
					if (restored) return;
					restored = true;
					eventFinalizersActive = false;
					if (eventFinalizers === finalizers) eventFinalizers = undefined;
				},
			};
		},
		sharedRuntime: runtimeFacade,
		get toolRegistry() {
			return registry;
		},
		beforeToolCall: async (...args) => options.beforeToolCall?.(...args),
		afterToolCall: async (...args) => options.afterToolCall?.(...args),
		getToolDefinition(name) {
			return definitions.get(name);
		},
		prepareToolArguments(name, rawArguments) {
			return createPiToolArgumentPreparer(registry)(name, rawArguments);
		},
		installRuntimeActions(replacements): PiRuntimeActionsInstallation {
			if (operationActive) throw new Error("runtime actions already installed");
			operationActive = true;
			let restored = false;
			const requireActive = () => {
				if (restored) throw new Error("Captured Pi runtime session is stale after restore");
			};
			actions = replacements;
			return {
				original: {
					getActiveTools() {
						requireActive();
						return rawGetActiveTools();
					},
					setActiveTools(names) {
						requireActive();
						rawSetActiveTools(names);
					},
					refreshTools() {
						requireActive();
						rawRefreshTools();
					},
					snapshotTools() {
						requireActive();
						return [...registry].map(([name, executable]) => ({
							name,
							executable,
							definition: definitions.get(name),
						}));
					},
				},
				restore(activeNames) {
					if (restored) return;
					if (activeNames) rawSetActiveTools([...activeNames]);
					restored = true;
					operationActive = false;
					if (actions === replacements) {
						actions = {
							getActiveTools: rawGetActiveTools,
							setActiveTools: rawSetActiveTools,
							refreshTools: rawRefreshTools,
						};
					}
				},
			};
		},
	};

	const ctx: ExtensionContext = {
		cwd: "/tmp",
		ui: {
			notify(message) {
				notifications.push(message);
			},
			setStatus(_key, text) {
				if (text) statuses.push(text);
			},
		},
		isProjectTrusted: () => true,
	};
	const pi: ExtensionAPI = {
		registerTool(definition) {
			const tool = definition as RegisteredTool;
			if (options.shadowTransport && tool.name === TRANSPORT_NAME && definitions.has(tool.name)) {
				return;
			}
			tools.set(tool.name, tool);
			definitions.set(tool.name, definition as object);
			desiredRegistry.set(tool.name, createExecutable(tool.name));
			if (runtimeBound) actions.refreshTools();
		},
		registerCommand(name, definition) {
			commands.set(name, definition as { handler: CommandHandler });
		},
		on(event, handler) {
			handlers.set(event, handler as EventHandler);
		},
		setActiveTools(names) {
			actions.setActiveTools(names);
		},
		getActiveTools() {
			return actions.getActiveTools();
		},
		getAllTools() {
			return [...desiredRegistry.keys()].map((name) => ({ name }));
		},
		appendEntry() {},
		events: { emit() {} },
	};
	const installOptions: InstallPtcOptions = {
		resolvePaths: tempPaths,
		installRuntimeCapture(installer) {
			captureInstaller = installer;
			return { compatible: true, teardown() {} };
		},
	};

	return {
		pi,
		tools,
		commands,
		handlers,
		notifications,
		statuses,
		ctx,
		installOptions,
		captureRuntime() {
			registry = new Map(desiredRegistry);
			runtimeBound = true;
			assert.ok(captureInstaller);
			captureInstaller.capturePiRuntime({ compatible: true, session: capturedSession });
		},
		captureObsoleteRuntime() {
			registry = new Map(desiredRegistry);
			runtimeBound = true;
			assert.ok(captureInstaller);
			const obsolete = { ...capturedSession, prepareToolArguments: undefined } as unknown;
			captureInstaller.capturePiRuntime({
				compatible: true,
				session: obsolete as CapturedPiSession,
			});
		},
		captureIncompatible(diagnostic = INERT_RUNTIME_DIAGNOSTIC, transportOwnership) {
			assert.ok(captureInstaller);
			captureInstaller.capturePiRuntime({
				compatible: false,
				diagnostic,
				transportOwnership,
			});
		},
		physicalActive: () => [...physical],
		physicalWriteCount: () => physicalWrites,
		registerRuntimeTool(name, executable = createExecutable(name), definition = { name }) {
			definitions.set(name, definition);
			desiredRegistry.set(name, executable);
			if (runtimeBound) actions.refreshTools();
			else if (!physical.includes(name)) physical.push(name);
		},
		async emitToolCall(event, afterPtcHandler) {
			let result = await handlers.get("tool_call")?.(event, ctx);
			const laterResult = afterPtcHandler?.();
			if (laterResult !== undefined) result = laterResult;
			return eventFinalizersActive && eventFinalizers
				? eventFinalizers.finalizeToolCall([event], result, ctx)
				: result;
		},
		async emitBeforeAgentStart(prompt, options = {}, afterPtcHandler) {
			const event = {
				type: "before_agent_start",
				prompt,
				systemPrompt: "base",
				systemPromptOptions: options,
			};
			let result = await handlers.get("before_agent_start")?.(event, ctx);
			const laterResult = afterPtcHandler?.();
			if (laterResult !== undefined) result = laterResult;
			return eventFinalizersActive && eventFinalizers
				? eventFinalizers.finalizeBeforeAgentStart(
						[prompt, undefined, "base", options],
						result,
						ctx,
					)
				: result;
		},
	};
}

export function installHarness(harness: FakePiHarness, options: InstallPtcOptions = {}): void {
	installPtc(harness.pi, { ...harness.installOptions, ...options });
}

export function startAndCapture(harness: FakePiHarness): void {
	harness.handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		harness.ctx,
	);
	harness.captureRuntime();
}
