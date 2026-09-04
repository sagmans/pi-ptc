import type { ExtensionAPI, ExtensionContext } from "../../src/host.ts";
import installPtc from "../../src/index.ts";
import {
	installPiRuntimeCapturePatch,
	type PiRuntimePatchInstallation,
	type PiRuntimeTool,
	SUPPORTED_PI_VERSION,
} from "../../src/pi-runtime.ts";
import type { EventHandler, RegisteredTool } from "./index-harness-shared.ts";

export type RealAdapterHarness = {
	tools: Map<string, RegisteredTool>;
	handlers: Map<string, EventHandler>;
	notifications: string[];
	notificationLevels: Array<string | undefined>;
	statuses: string[];
	ctx: ExtensionContext;
	start(): Promise<void>;
	registerRuntimeTool(name: string, executable: PiRuntimeTool, definition?: object): void;
	setActiveTools(names: string[]): void;
	physicalActive(): string[];
	shutdown(): void;
};

export type RealAdapterHarnessOptions = {
	beforeSetActiveTools?(names: readonly string[]): void;
	projectActiveTools?(availableNames: readonly string[]): string[];
};

export function createRealAdapterHarness(
	active: string[],
	initialTools: ReadonlyArray<readonly [string, PiRuntimeTool, object]>,
	options: RealAdapterHarnessOptions = {},
): RealAdapterHarness {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, EventHandler>();
	const notifications: string[] = [];
	const notificationLevels: Array<string | undefined> = [];
	const statuses: string[] = [];
	const definitions = new Map(
		initialTools.map(([name, _executable, definition]) => [name, definition]),
	);
	const desiredRegistry = new Map(initialTools.map(([name, executable]) => [name, executable]));
	let physical = [...active];
	let runtimeBound = false;
	let installation: PiRuntimePatchInstallation | undefined;
	const ctx: ExtensionContext = {
		cwd: "/tmp",
		ui: {
			notify(message, level) {
				notifications.push(message);
				notificationLevels.push(level);
			},
			setStatus(_key, text) {
				if (text) statuses.push(text);
			},
		},
		isProjectTrusted: () => true,
	};

	class AdapterSession {
		agent = {
			beforeToolCall: async () => undefined,
			afterToolCall: async () => undefined,
		};
		_toolRegistry = new Map(desiredRegistry);
		extensionRunner = {
			createContext: () => ctx,
			emit: async () => undefined,
			emitToolCall: async () => undefined,
			emitBeforeAgentStart: async () => undefined,
			runtime: {
				getActiveTools: () => [...physical],
				setActiveTools: (names: string[]) => {
					options.beforeSetActiveTools?.(names);
					const availableNames = names.filter((name) => this._toolRegistry.has(name));
					physical = options.projectActiveTools?.(availableNames) ?? availableNames;
				},
				refreshTools: () => {
					const previousRegistryNames = new Set(this._toolRegistry.keys());
					const previousActiveNames = [...physical];
					this._toolRegistry = new Map(desiredRegistry);
					const nextActiveNames = previousActiveNames.filter((name) =>
						this._toolRegistry.has(name),
					);
					for (const name of this._toolRegistry.keys()) {
						if (!previousRegistryNames.has(name)) nextActiveNames.push(name);
					}
					physical = [...new Set(nextActiveNames)];
				},
			},
		};

		getToolDefinition(name: string): object | undefined {
			return definitions.get(name);
		}

		async bindExtensions(): Promise<void> {}
		async reload(): Promise<void> {}
	}

	const session = new AdapterSession();
	const pi: ExtensionAPI = {
		registerTool(definition) {
			const tool = definition as RegisteredTool;
			tools.set(tool.name, tool);
			definitions.set(tool.name, definition as object);
			desiredRegistry.set(tool.name, definition as unknown as PiRuntimeTool);
			if (runtimeBound) session.extensionRunner.runtime.refreshTools();
		},
		registerCommand() {},
		on(event, handler) {
			handlers.set(event, handler as EventHandler);
		},
		setActiveTools(names) {
			session.extensionRunner.runtime.setActiveTools(names);
		},
		getActiveTools() {
			return session.extensionRunner.runtime.getActiveTools();
		},
		getAllTools() {
			return [...desiredRegistry.keys()].map((name) => ({ name }));
		},
		appendEntry() {},
		events: { emit() {} },
	};
	installPtc(pi, {
		installRuntimeCapture() {
			installation = installPiRuntimeCapturePatch({
				agentSession: AdapterSession,
				version: SUPPORTED_PI_VERSION,
			});
			return installation;
		},
	});

	return {
		tools,
		handlers,
		notifications,
		notificationLevels,
		statuses,
		ctx,
		async start() {
			session.extensionRunner.runtime.refreshTools();
			handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
			runtimeBound = true;
			await session.bindExtensions();
		},
		registerRuntimeTool(name, executable, definition = { name }) {
			definitions.set(name, definition);
			desiredRegistry.set(name, executable);
			if (runtimeBound) session.extensionRunner.runtime.refreshTools();
		},
		setActiveTools(names) {
			pi.setActiveTools(names);
		},
		physicalActive: () => [...physical],
		shutdown() {
			handlers.get("session_shutdown")?.({}, ctx);
			if (installation?.compatible) installation.teardown();
		},
	};
}
