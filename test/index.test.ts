import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { LEAK_BLOCK_REASON, loadPresentation, TRANSPORT_NAME } from "../src/config.ts";
import type { PtcDispatchDetails } from "../src/dispatch-details.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/host.ts";
import installPtc, { type InstallPtcOptions } from "../src/index.ts";
import {
	type CapturedPiSession,
	installPiRuntimeCapturePatch,
	type PiRuntimeActionsInstallation,
	type PiRuntimeEventFinalizers,
	type PiRuntimeEventFinalizersInstallation,
	type PiRuntimeInstaller,
	type PiRuntimePatchInstallation,
	type PiRuntimeTool,
	SUPPORTED_PI_VERSION,
} from "../src/pi-runtime.ts";
import type { PtcParams, PtcPartialResult, PtcToolResult } from "../src/transport.ts";

const FAILURE_TOOL_CALL_ID = "ptc-failure";
const SHUTDOWN_TOOL_CALL_ID = "ptc-shutdown";
const MISSING_TOOL_CALL_ID = "ptc-missing";
const SHARED_TOOL_CALL_ID = "ptc-shared";
const FAILURE_DESCRIPTION = "fail after nested dispatch";
const FIRST_FAILURE_DESCRIPTION = "first installer failure";
const SECOND_FAILURE_DESCRIPTION = "second installer failure";
const OUTER_FAILURE_MESSAGE = "planned outer failure";
const FIRST_OUTER_FAILURE_MESSAGE = "first planned failure";
const SECOND_OUTER_FAILURE_MESSAGE = "second planned failure";
const FAILURE_PROGRAM = `await tools.ls({ path: "." }); throw new Error("${OUTER_FAILURE_MESSAGE}");`;
const FIRST_FAILURE_PROGRAM = `throw new Error("${FIRST_OUTER_FAILURE_MESSAGE}");`;
const SECOND_FAILURE_PROGRAM = `throw new Error("${SECOND_OUTER_FAILURE_MESSAGE}");`;

const INERT_RUNTIME_DIAGNOSTIC = "Unsupported Pi runtime version: test mismatch";
const REAL_CHARACTERIZATION_DIRECTORY_PREFIX = "pi-ptc-missing-capture-";
const REAL_LATE_OWNER_DIRECTORY_PREFIX = "pi-ptc-late-owner-";
const REAL_RELOAD_DIRECTORY_PREFIX = "pi-ptc-reload-shutdown-";
const COMPETING_TOOL_NAME = "fabric_exec";
const LATE_OWNER_SYSTEM_PROMPT = "late owner system prompt";
const LATE_OWNER_TOOL_CALL_ID = "late-owner-tool-call";
const SHUTDOWN_REFRESH_TOOL_NAME = "shutdown_refresh_probe";

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;
type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type RegisteredTool = {
	name: string;
	execute(
		toolCallId: string,
		params: PtcParams,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: PtcPartialResult) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<PtcToolResult>;
};

type FakePiHarness = {
	pi: ExtensionAPI;
	tools: Map<string, RegisteredTool>;
	commands: Map<string, { handler: CommandHandler }>;
	handlers: Map<string, EventHandler>;
	notifications: string[];
	statuses: string[];
	ctx: ExtensionContext;
	installOptions: InstallPtcOptions;
	captureRuntime(): void;
	captureIncompatible(diagnostic?: string): void;
	physicalActive(): string[];
	physicalWriteCount(): number;
	registerRuntimeTool(name: string): void;
	emitToolCall(event: unknown, afterPtcHandler?: () => unknown): Promise<unknown>;
	emitBeforeAgentStart(
		prompt: string,
		options?: { skills?: unknown[] },
		afterPtcHandler?: () => unknown,
	): Promise<unknown>;
};

function createExecutable(name: string): PiRuntimeTool {
	return {
		parameters: { type: "object", name },
		executionMode: "parallel",
		async execute() {
			return { content: [], details: { name } };
		},
	};
}

function createFakePi(
	active: string[],
	available: string[] = active,
	options: { shadowTransport?: boolean } = {},
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
		beforeToolCall: async () => undefined,
		afterToolCall: async () => undefined,
		getToolDefinition(name) {
			return definitions.get(name);
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
		captureIncompatible(diagnostic = INERT_RUNTIME_DIAGNOSTIC) {
			assert.ok(captureInstaller);
			captureInstaller.capturePiRuntime({ compatible: false, diagnostic });
		},
		physicalActive: () => [...physical],
		physicalWriteCount: () => physicalWrites,
		registerRuntimeTool(name) {
			pi.registerTool({ name });
			if (!runtimeBound && !physical.includes(name)) physical.push(name);
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

function tempPaths() {
	const dir = mkdtempSync(join(tmpdir(), "pi-ptc-index-"));
	return {
		projectFile: join(dir, "project", "ptc.json"),
		userFile: join(dir, "user", "ptc.json"),
	};
}

function installHarness(harness: FakePiHarness, options: InstallPtcOptions = {}): void {
	installPtc(harness.pi, { ...harness.installOptions, ...options });
}

function startAndCapture(harness: FakePiHarness): void {
	harness.handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		harness.ctx,
	);
	harness.captureRuntime();
}

test("installer patches capture before registering a tagged transport", () => {
	const harness = createFakePi(["read", "bash", "mcp"]);
	let patchInstalled = false;
	installPtc(harness.pi, {
		resolvePaths: tempPaths,
		installRuntimeCapture(installer) {
			assert.equal(
				harness.pi.getAllTools().some((tool) => tool.name === TRANSPORT_NAME),
				false,
			);
			assert.equal(typeof installer.capturePiRuntime, "function");
			patchInstalled = true;
			return { compatible: true, teardown() {} };
		},
	});
	assert.equal(patchInstalled, true);
	assert.equal(
		harness.pi.getAllTools().some((tool) => tool.name === TRANSPORT_NAME),
		true,
	);
});

test("real Pi allowlist without ptc stays native and inert after bind session_start", async () => {
	const directory = mkdtempSync(join(tmpdir(), REAL_CHARACTERIZATION_DIRECTORY_PREFIX));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const notifications: string[] = [];
	const statuses: string[] = [];
	const handlers = new Map<string, EventHandler>();
	let context: ExtensionContext | undefined;
	let patchInstallation: PiRuntimePatchInstallation | undefined;
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [
			{
				name: "ptc-missing-capture-characterization",
				factory(realPi) {
					const api = realPi as unknown as ExtensionAPI;
					const interceptedApi = new Proxy(api, {
						get(target, property) {
							if (property === "on") {
								return (event: string, handler: EventHandler): void => {
									handlers.set(event, handler);
									target.on(event, (value, ctx) => {
										context = ctx as ExtensionContext;
										return handler(value, ctx as ExtensionContext);
									});
								};
							}
							const value = Reflect.get(target, property, target);
							return typeof value === "function" ? value.bind(target) : value;
						},
					});
					installPtc(interceptedApi, {
						resolvePaths: () => ({
							projectFile: join(cwd, ".pi", "ptc.json"),
							userFile: join(agentDir, "ptc.json"),
						}),
						installRuntimeCapture() {
							patchInstallation = installPiRuntimeCapturePatch();
							return patchInstallation;
						},
					});
				},
			},
		],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "",
	});

	try {
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
			tools: ["read"],
		});
		const uiContext = {
			notify(message: string) {
				notifications.push(message);
			},
			setStatus(_key: string, text: string | undefined) {
				if (text) statuses.push(text);
			},
		};

		await session.bindExtensions({ mode: "print", uiContext: uiContext as never });
		assert.deepEqual(session.getActiveToolNames(), ["read"]);
		assert.equal(
			session.getAllTools().some((tool) => tool.name === TRANSPORT_NAME),
			false,
		);
		assert.ok(context);
		const toolCallResult = await handlers.get("tool_call")?.(
			{ type: "tool_call", toolName: "read" },
			context,
		);
		assert.equal(toolCallResult, undefined);
		const beforeAgentStartResult = await handlers.get("before_agent_start")?.(
			{ type: "before_agent_start", systemPrompt: "native" },
			context,
		);
		assert.equal(beforeAgentStartResult, undefined);
		assert.deepEqual(session.getActiveToolNames(), ["read"]);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0] ?? "", /inert|capture/i);
		assert.deepEqual(statuses, ["ptc: inert"]);
	} finally {
		if (patchInstallation?.compatible) patchInstallation.teardown();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("real Pi late owner before ptc readiness restores native state without SDK injection", async () => {
	const directory = mkdtempSync(join(tmpdir(), REAL_LATE_OWNER_DIRECTORY_PREFIX));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const notifications: string[] = [];
	const statuses: string[] = [];
	const eventOrder: string[] = [];
	const installations: PiRuntimePatchInstallation[] = [];
	let capturedSession: CapturedPiSession | undefined;
	let registeredAtPtcReadiness: string[] = [];
	let ptcBeforeAgentStartResult: unknown = Symbol("not-called");
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [
			{
				name: "late-owner",
				factory(pi) {
					pi.on("before_agent_start", () => {
						eventOrder.push("owner");
						pi.registerTool(
							defineTool({
								name: COMPETING_TOOL_NAME,
								label: "Late competing owner",
								description: "Registers after pi-ptc capture",
								parameters: Type.Object({}),
								execute: async () => ({ content: [], details: undefined }),
							}),
						);
					});
				},
			},
			{
				name: "pi-ptc",
				factory(realPi) {
					const api = realPi as unknown as ExtensionAPI;
					const interceptedApi = new Proxy(api, {
						get(target, property) {
							if (property === "on") {
								return (event: string, handler: EventHandler): void => {
									if (event !== "before_agent_start") {
										target.on(event, (value, ctx) => handler(value, ctx as ExtensionContext));
										return;
									}
									target.on(event, async (value, ctx) => {
										eventOrder.push("ptc");
										registeredAtPtcReadiness = target.getAllTools().map((tool) => tool.name);
										ptcBeforeAgentStartResult = await handler(value, ctx as ExtensionContext);
										return ptcBeforeAgentStartResult;
									});
								};
							}
							const value = Reflect.get(target, property, target);
							return typeof value === "function" ? value.bind(target) : value;
						},
					});
					installPtc(interceptedApi, {
						resolvePaths: () => ({
							projectFile: join(cwd, ".pi", "ptc.json"),
							userFile: join(agentDir, "ptc.json"),
						}),
						installRuntimeCapture(installer) {
							const capturePiRuntime = installer.capturePiRuntime.bind(installer);
							installer.capturePiRuntime = (capture) => {
								if (capture.compatible) capturedSession = capture.session;
								capturePiRuntime(capture);
							};
							const installation = installPiRuntimeCapturePatch();
							installations.push(installation);
							return installation;
						},
					});
				},
			},
		],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "",
	});

	try {
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
			tools: ["read", TRANSPORT_NAME, COMPETING_TOOL_NAME],
		});
		const uiContext = {
			notify(message: string) {
				notifications.push(message);
			},
			setStatus(_key: string, text: string | undefined) {
				if (text) statuses.push(text);
			},
		};

		await session.bindExtensions({ mode: "print", uiContext: uiContext as never });
		assert.deepEqual(session.getActiveToolNames(), [TRANSPORT_NAME]);
		assert.ok(capturedSession);

		const runner = session.extensionRunner as unknown as {
			emitBeforeAgentStart(
				prompt: string,
				images: undefined,
				systemPrompt: string,
				options: object,
			): Promise<unknown>;
		};
		const aggregate = await runner.emitBeforeAgentStart("prompt", undefined, "native", {
			cwd,
			skills: [],
		});
		assert.equal(aggregate, undefined);

		assert.deepEqual(eventOrder, ["owner", "ptc"]);
		assert.equal(registeredAtPtcReadiness.includes(COMPETING_TOOL_NAME), true);
		assert.equal(ptcBeforeAgentStartResult, undefined);
		assert.deepEqual(session.getActiveToolNames(), ["read", COMPETING_TOOL_NAME]);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0] ?? "", /competing|inert/i);
		assert.equal(statuses.filter((status) => status === "ptc: inert").length, 1);
	} finally {
		for (const installation of installations.reverse()) {
			if (installation.compatible) installation.teardown();
		}
		rmSync(directory, { recursive: true, force: true });
	}
});

test("real Pi PTC-first finalizers defer competing-owner decisions until later handlers run", async () => {
	const cases = ["before_agent_start", "tool_call"] as const;
	for (const eventName of cases) {
		const directory = mkdtempSync(join(tmpdir(), REAL_LATE_OWNER_DIRECTORY_PREFIX));
		const cwd = join(directory, "project");
		const agentDir = join(directory, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const notifications: string[] = [];
		const statuses: string[] = [];
		const eventOrder: string[] = [];
		const installations: PiRuntimePatchInstallation[] = [];
		let ownerHandlerRan = false;
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [
				{
					name: "pi-ptc-first",
					factory(realPi) {
						const api = realPi as unknown as ExtensionAPI;
						const interceptedApi = new Proxy(api, {
							get(target, property) {
								if (property === "on") {
									return (event: string, handler: EventHandler): void => {
										target.on(event, async (value, ctx) => {
											if (event === eventName) eventOrder.push("ptc");
											return handler(value, ctx as ExtensionContext);
										});
									};
								}
								const value = Reflect.get(target, property, target);
								return typeof value === "function" ? value.bind(target) : value;
							},
						});
						installPtc(interceptedApi, {
							resolvePaths: () => ({
								projectFile: join(cwd, ".pi", "ptc.json"),
								userFile: join(agentDir, "ptc.json"),
							}),
							installRuntimeCapture(_installer) {
								const installation = installPiRuntimeCapturePatch();
								installations.push(installation);
								return installation;
							},
						});
					},
				},
				{
					name: "late-owner-second",
					factory(pi) {
						const api = pi as unknown as ExtensionAPI;
						api.on(eventName, () => {
							eventOrder.push("owner");
							ownerHandlerRan = true;
							pi.registerTool(
								defineTool({
									name: COMPETING_TOOL_NAME,
									label: "Late competing owner",
									description: "Registers after the PTC event marker",
									parameters: Type.Object({}),
									execute: async () => ({ content: [], details: undefined }),
								}),
							);
							return eventName === "before_agent_start"
								? { systemPrompt: LATE_OWNER_SYSTEM_PROMPT }
								: undefined;
						});
					},
				},
			],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "",
		});

		try {
			await resourceLoader.reload();
			const modelRuntime = await ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: null,
				refreshOnCreate: false,
			});
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				modelRuntime,
				resourceLoader,
				sessionManager: SessionManager.inMemory(cwd),
				settingsManager,
				tools: ["read", TRANSPORT_NAME, COMPETING_TOOL_NAME],
			});
			const uiContext = {
				notify(message: string) {
					notifications.push(message);
				},
				setStatus(_key: string, text: string | undefined) {
					if (text) statuses.push(text);
				},
			};

			await session.bindExtensions({ mode: "print", uiContext: uiContext as never });
			assert.deepEqual(session.getActiveToolNames(), [TRANSPORT_NAME], eventName);
			let result: unknown;
			if (eventName === "before_agent_start") {
				const runner = session.extensionRunner as unknown as {
					emitBeforeAgentStart(
						prompt: string,
						images: undefined,
						systemPrompt: string,
						options: object,
					): Promise<unknown>;
				};
				result = await runner.emitBeforeAgentStart("prompt", undefined, "native", {
					cwd,
					skills: [],
				});
				assert.deepEqual(result, {
					messages: undefined,
					systemPrompt: LATE_OWNER_SYSTEM_PROMPT,
				});
				assert.equal(JSON.stringify(result).includes("await tools.read"), false);
			} else {
				result = await session.agent.beforeToolCall?.({
					toolCall: {
						type: "toolCall",
						id: LATE_OWNER_TOOL_CALL_ID,
						name: "read",
						arguments: {},
					},
					args: {},
				} as never);
				assert.equal(result, undefined);
			}

			assert.equal(ownerHandlerRan, true, eventName);
			assert.deepEqual(eventOrder, ["ptc", "owner"], eventName);
			assert.deepEqual(session.getActiveToolNames(), ["read", COMPETING_TOOL_NAME], eventName);
			assert.equal(notifications.length, 1, eventName);
			assert.match(notifications[0] ?? "", /competing|inert/i, eventName);
			assert.equal(statuses.filter((status) => status === "ptc: inert").length, 1, eventName);
		} finally {
			for (const installation of installations.reverse()) {
				if (installation.compatible) installation.teardown();
			}
			rmSync(directory, { recursive: true, force: true });
		}
	}
});

test("real Pi reload retains actions through earlier shutdown and captures after session_start", async () => {
	const directory = mkdtempSync(join(tmpdir(), REAL_RELOAD_DIRECTORY_PREFIX));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const captures: CapturedPiSession[] = [];
	const captureCountsAtSessionStart: number[] = [];
	const shutdownErrors: unknown[] = [];
	const shutdownOrder: string[] = [];
	const activeAfterPtcShutdown: string[][] = [];
	const activeAtSessionStart: string[][] = [];
	const retainedActiveDuringShutdown: string[][] = [];
	const installations: PiRuntimePatchInstallation[] = [];
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [
			{
				name: "earlier-runtime-user",
				factory(pi) {
					pi.on("session_start", () => {
						captureCountsAtSessionStart.push(captures.length);
						activeAtSessionStart.push(pi.getActiveTools());
					});
					pi.on("session_shutdown", () => {
						shutdownOrder.push("earlier");
						try {
							const active = pi.getActiveTools();
							pi.setActiveTools(active);
							pi.registerTool(
								defineTool({
									name: SHUTDOWN_REFRESH_TOOL_NAME,
									label: "Shutdown refresh probe",
									description: "Exercises extension tool refresh during shutdown",
									parameters: Type.Object({}),
									execute: async () => ({ content: [], details: undefined }),
								}),
							);
							const retained = captures.at(-1);
							assert.ok(retained);
							const retainedActive = retained.sharedRuntime.getActiveTools();
							retained.sharedRuntime.setActiveTools(retainedActive);
							retained.sharedRuntime.refreshTools();
							retainedActiveDuringShutdown.push(retainedActive);
						} catch (error) {
							shutdownErrors.push(error);
						}
					});
				},
			},
			{
				name: "pi-ptc",
				factory(realPi) {
					installPtc(realPi as unknown as ExtensionAPI, {
						resolvePaths: () => ({
							projectFile: join(cwd, ".pi", "ptc.json"),
							userFile: join(agentDir, "ptc.json"),
						}),
						installRuntimeCapture(installer) {
							const capturePiRuntime = installer.capturePiRuntime.bind(installer);
							installer.capturePiRuntime = (capture) => {
								if (capture.compatible) captures.push(capture.session);
								capturePiRuntime(capture);
							};
							const installation = installPiRuntimeCapturePatch();
							installations.push(installation);
							return installation;
						},
					});
				},
			},
			{
				name: "later-runtime-observer",
				factory(pi) {
					pi.on("session_shutdown", () => {
						shutdownOrder.push("later");
						activeAfterPtcShutdown.push(pi.getActiveTools());
					});
				},
			},
		],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "",
	});

	try {
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
			tools: ["read", TRANSPORT_NAME],
		});
		const uiContext = { notify() {}, setStatus() {} };

		await session.bindExtensions({ mode: "print", uiContext: uiContext as never });
		const oldCapture = captures[0];
		assert.ok(oldCapture);
		assert.deepEqual(session.getActiveToolNames(), [TRANSPORT_NAME]);

		await session.reload();

		assert.deepEqual(shutdownErrors, []);
		assert.deepEqual(shutdownOrder, ["earlier", "later"]);
		assert.deepEqual(retainedActiveDuringShutdown, [["read", TRANSPORT_NAME]]);
		assert.deepEqual(activeAfterPtcShutdown, [["read"]]);
		assert.deepEqual(captureCountsAtSessionStart, [0, 1]);
		assert.deepEqual(activeAtSessionStart, [
			["read", TRANSPORT_NAME],
			["read", TRANSPORT_NAME],
		]);
		assert.equal(captures.length, 2);
		assert.throws(() => oldCapture.sharedRuntime.getActiveTools(), /no longer associated/);
		assert.deepEqual(session.getActiveToolNames(), [TRANSPORT_NAME]);
		assert.deepEqual(captures[1]?.sharedRuntime.getActiveTools(), ["read", TRANSPORT_NAME]);
	} finally {
		for (const installation of installations.reverse()) {
			if (installation.compatible) installation.teardown();
		}
		rmSync(directory, { recursive: true, force: true });
	}
});

test("post-bind capture applies after pending session_start without premature inert state", () => {
	const harness = createFakePi([
		"read",
		"bash",
		"edit",
		"write",
		"grep",
		"find",
		"ls",
		"mcp",
		"mcpScript",
	]);
	installHarness(harness);
	const writesBefore = harness.physicalWriteCount();

	harness.handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		harness.ctx,
	);

	assert.deepEqual(harness.physicalActive(), [
		"read",
		"bash",
		"edit",
		"write",
		"grep",
		"find",
		"ls",
		"mcp",
		"mcpScript",
	]);
	assert.equal(harness.physicalWriteCount(), writesBefore);
	assert.deepEqual(harness.notifications, []);
	assert.deepEqual(harness.statuses, []);

	harness.captureRuntime();

	assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);
	assert.deepEqual(harness.pi.getActiveTools(), [
		"read",
		"bash",
		"edit",
		"write",
		"grep",
		"find",
		"ls",
		"mcp",
		"mcpScript",
		TRANSPORT_NAME,
	]);
	assert.deepEqual(harness.notifications, []);
	assert.deepEqual(harness.statuses, ["ptc: code"]);
});

test("session_start preserves an intentionally empty logical active set", () => {
	const harness = createFakePi([], ["read", "bash", "mcp"]);
	installHarness(harness);
	startAndCapture(harness);
	assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);
	assert.deepEqual(harness.pi.getActiveTools(), [TRANSPORT_NAME]);
});

test("another extension read-modify-write keeps hidden logical tools under code", () => {
	const harness = createFakePi(["read", "bash", "mcp"], ["read", "bash", "mcp", "web_search"]);
	installHarness(harness);
	startAndCapture(harness);

	const active = harness.pi.getActiveTools();
	harness.pi.setActiveTools([...active.filter((name) => name !== "bash"), "web_search"]);

	assert.deepEqual(harness.pi.getActiveTools(), ["read", "mcp", "web_search", TRANSPORT_NAME]);
	assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);
	harness.handlers.get("turn_start")?.({}, harness.ctx);
	assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);
});

test("tools registered during session_start enter the first post-bind capture", () => {
	const harness = createFakePi(["read"]);
	installHarness(harness);
	harness.handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		harness.ctx,
	);
	harness.registerRuntimeTool("session_tool");
	harness.captureRuntime();

	assert.deepEqual(harness.pi.getActiveTools(), ["read", "session_tool", TRANSPORT_NAME]);
	assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);
});

test("tools registered from command handlers refresh logical state without native exposure", () => {
	const harness = createFakePi(["read", "mcp"]);
	installHarness(harness);
	startAndCapture(harness);

	harness.registerRuntimeTool("command_tool");

	assert.deepEqual(harness.pi.getActiveTools(), ["read", "mcp", "command_tool", TRANSPORT_NAME]);
	assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);
});

test("session catalogs do not leak logical state or teardown across installers", () => {
	const first = createFakePi(["read"], ["read", "first_only"]);
	const second = createFakePi(["bash"], ["bash", "second_only"]);
	installHarness(first);
	installHarness(second);
	startAndCapture(first);
	startAndCapture(second);

	first.pi.setActiveTools(["read", "first_only", TRANSPORT_NAME]);
	assert.deepEqual(first.pi.getActiveTools(), ["read", "first_only", TRANSPORT_NAME]);
	assert.deepEqual(second.pi.getActiveTools(), ["bash", TRANSPORT_NAME]);
	first.handlers.get("session_shutdown")?.({}, first.ctx);
	assert.deepEqual(first.physicalActive(), ["read", "first_only"]);
	assert.deepEqual(second.physicalActive(), [TRANSPORT_NAME]);
	assert.deepEqual(second.pi.getActiveTools(), ["bash", TRANSPORT_NAME]);
});

test("competing owner is inert and restores native logical tools when detected later", async () => {
	const initial = createFakePi(["read", "bash", COMPETING_TOOL_NAME]);
	installHarness(initial);
	startAndCapture(initial);
	assert.deepEqual(initial.physicalActive(), ["read", "bash", COMPETING_TOOL_NAME]);
	assert.match(initial.notifications[0] ?? "", /inert/);

	const readinessCases: Array<{
		name: string;
		invoke(harness: FakePiHarness): unknown;
	}> = [
		{
			name: "turn_start",
			invoke: (harness) => harness.handlers.get("turn_start")?.({}, harness.ctx),
		},
		{
			name: "/ptc",
			invoke: (harness) => harness.commands.get("ptc")?.handler("off", harness.ctx),
		},
		{
			name: "tool_call",
			invoke: (harness) => harness.emitToolCall({ toolName: "read" }),
		},
		{
			name: "before_agent_start",
			invoke: (harness) => harness.emitBeforeAgentStart("prompt"),
		},
	];

	for (const readinessCase of readinessCases) {
		const later = createFakePi(["read", "bash"]);
		installHarness(later);
		startAndCapture(later);
		later.registerRuntimeTool(COMPETING_TOOL_NAME);
		assert.deepEqual(later.physicalActive(), [TRANSPORT_NAME], readinessCase.name);

		assert.equal(await readinessCase.invoke(later), undefined, readinessCase.name);
		assert.deepEqual(
			later.physicalActive(),
			["read", "bash", COMPETING_TOOL_NAME],
			readinessCase.name,
		);
		assert.equal(later.notifications.length, 1, readinessCase.name);
		assert.match(later.notifications[0] ?? "", /competing|inert/i, readinessCase.name);
		assert.equal(
			later.statuses.filter((status) => status === "ptc: inert").length,
			1,
			readinessCase.name,
		);
	}
});

test("post-aggregation finalizers detect owners registered after PTC marker handlers", async () => {
	const toolCallHarness = createFakePi(["read", "bash"]);
	installHarness(toolCallHarness);
	startAndCapture(toolCallHarness);

	const toolCallResult = await toolCallHarness.emitToolCall({ toolName: "read" }, () => {
		toolCallHarness.registerRuntimeTool(COMPETING_TOOL_NAME);
	});

	assert.equal(toolCallResult, undefined);
	assert.deepEqual(toolCallHarness.physicalActive(), ["read", "bash", COMPETING_TOOL_NAME]);
	assert.equal(toolCallHarness.notifications.length, 1);

	const beforeStartHarness = createFakePi(["read", "bash"]);
	installHarness(beforeStartHarness);
	startAndCapture(beforeStartHarness);

	const beforeStartResult = await beforeStartHarness.emitBeforeAgentStart(
		"prompt",
		{ skills: [] },
		() => {
			beforeStartHarness.registerRuntimeTool(COMPETING_TOOL_NAME);
		},
	);

	assert.equal(beforeStartResult, undefined);
	assert.deepEqual(beforeStartHarness.physicalActive(), ["read", "bash", COMPETING_TOOL_NAME]);
	assert.equal(beforeStartHarness.notifications.length, 1);
});

test("compatibility mismatch stays inert, preserves actions, and reports once with context", () => {
	const harness = createFakePi(["read", "bash"]);
	installPtc(harness.pi, {
		resolvePaths: tempPaths,
		installRuntimeCapture() {
			return { compatible: false, diagnostic: INERT_RUNTIME_DIAGNOSTIC };
		},
	});
	const writesBefore = harness.physicalWriteCount();

	harness.handlers.get("session_start")?.({}, harness.ctx);
	harness.handlers.get("turn_start")?.({}, harness.ctx);

	assert.deepEqual(harness.physicalActive(), ["read", "bash"]);
	assert.equal(harness.physicalWriteCount(), writesBefore);
	assert.equal(harness.tools.has(TRANSPORT_NAME), false);
	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0] ?? "", /Unsupported Pi runtime version/);
	assert.equal(harness.statuses.at(-1), "ptc: inert");
});

test("same-name untagged ptc shadow becomes inert at first post-bind readiness event", async () => {
	const harness = createFakePi(["read", TRANSPORT_NAME], ["read", TRANSPORT_NAME], {
		shadowTransport: true,
	});
	installHarness(harness);
	const writesBefore = harness.physicalWriteCount();

	harness.handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		harness.ctx,
	);
	assert.equal(harness.tools.has(TRANSPORT_NAME), false);
	assert.deepEqual(harness.physicalActive(), ["read", TRANSPORT_NAME]);
	assert.deepEqual(harness.pi.getActiveTools(), ["read", TRANSPORT_NAME]);
	assert.equal(harness.physicalWriteCount(), writesBefore);
	assert.deepEqual(harness.notifications, []);
	assert.deepEqual(harness.statuses, []);

	assert.equal(harness.handlers.get("tool_call")?.({ toolName: "read" }, harness.ctx), undefined);
	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0] ?? "", /inert|capture/i);
	assert.deepEqual(harness.statuses, ["ptc: inert"]);

	assert.equal(
		harness.handlers.get("before_agent_start")?.({ systemPrompt: "native" }, harness.ctx),
		undefined,
	);
	await harness.commands.get("ptc")?.handler("off", harness.ctx);
	harness.handlers.get("turn_start")?.({}, harness.ctx);
	assert.deepEqual(harness.physicalActive(), ["read", TRANSPORT_NAME]);
	assert.equal(harness.physicalWriteCount(), writesBefore);
	assert.equal(harness.notifications.length, 1);
	assert.deepEqual(harness.statuses, ["ptc: inert"]);
});

test("every post-bind readiness entry point resolves pending capture without blocking or injection", async () => {
	const readinessCases: Array<{
		name: string;
		invoke(harness: FakePiHarness): unknown;
	}> = [
		{
			name: "turn_start",
			invoke: (harness) => harness.handlers.get("turn_start")?.({}, harness.ctx),
		},
		{
			name: "/ptc",
			invoke: (harness) => harness.commands.get("ptc")?.handler("off", harness.ctx),
		},
		{
			name: "tool_call",
			invoke: (harness) => harness.handlers.get("tool_call")?.({ toolName: "read" }, harness.ctx),
		},
		{
			name: "before_agent_start",
			invoke: (harness) =>
				harness.handlers.get("before_agent_start")?.({ systemPrompt: "native" }, harness.ctx),
		},
	];

	for (const readinessCase of readinessCases) {
		const harness = createFakePi(["read", TRANSPORT_NAME], ["read", TRANSPORT_NAME], {
			shadowTransport: true,
		});
		installHarness(harness);
		const writesBefore = harness.physicalWriteCount();
		harness.handlers.get("session_start")?.(
			{ type: "session_start", reason: "startup" },
			harness.ctx,
		);
		assert.deepEqual(harness.notifications, [], readinessCase.name);
		assert.deepEqual(harness.statuses, [], readinessCase.name);

		assert.equal(await readinessCase.invoke(harness), undefined, readinessCase.name);
		assert.deepEqual(harness.physicalActive(), ["read", TRANSPORT_NAME], readinessCase.name);
		assert.equal(harness.physicalWriteCount(), writesBefore, readinessCase.name);
		assert.equal(harness.notifications.length, 1, readinessCase.name);
		assert.match(harness.notifications[0] ?? "", /inert|capture/i, readinessCase.name);
		assert.deepEqual(harness.statuses, ["ptc: inert"], readinessCase.name);
	}
});

test("captured shape mismatch remains native and reports when session context exists", () => {
	const harness = createFakePi(["read", "bash"]);
	installHarness(harness);
	const writesBefore = harness.physicalWriteCount();

	harness.captureIncompatible("Bound AgentSession._toolRegistry is unavailable");
	harness.handlers.get("session_start")?.({}, harness.ctx);

	assert.deepEqual(harness.physicalActive(), ["read", "bash"]);
	assert.equal(harness.physicalWriteCount(), writesBefore);
	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0] ?? "", /_toolRegistry/);
});

test("tool_call blocks leaked core tools under code presentation", async () => {
	const harness = createFakePi(["read", "bash", "mcp"]);
	installHarness(harness);
	startAndCapture(harness);
	const blocked = await harness.emitToolCall({ toolName: "read" });
	assert.deepEqual(blocked, { block: true, reason: LEAK_BLOCK_REASON });
	assert.equal(await harness.emitToolCall({ toolName: "mcp" }), undefined);
});

test("post-aggregation finalizers preserve foreign blocks and aggregate messages", async () => {
	const harness = createFakePi(["read", "bash", "mcp"]);
	installHarness(harness);
	startAndCapture(harness);
	const foreignBlock = { block: true, reason: "foreign block" };

	assert.equal(await harness.emitToolCall({ toolName: "read" }, () => foreignBlock), foreignBlock);
	const foreignMessage = { customType: "foreign", content: [] };
	const beforeResult = (await harness.emitBeforeAgentStart("prompt", { skills: [] }, () => ({
		messages: [foreignMessage],
		systemPrompt: "foreign prompt",
	}))) as { messages: unknown[]; systemPrompt: string };
	assert.deepEqual(beforeResult.messages, [foreignMessage]);
	assert.match(beforeResult.systemPrompt, /^foreign prompt/);
	assert.match(beforeResult.systemPrompt, /await tools\.read\(/);
});

test("/ptc off restores native logical tools and persists", async () => {
	const paths = tempPaths();
	const harness = createFakePi(["read", "bash", "mcp"]);
	installHarness(harness, { resolvePaths: () => paths });
	startAndCapture(harness);
	await harness.commands.get("ptc")?.handler("off", harness.ctx);
	assert.deepEqual(harness.physicalActive(), ["read", "bash", "mcp"]);
	assert.deepEqual(harness.pi.getActiveTools(), ["read", "bash", "mcp"]);
	assert.equal(loadPresentation({ projectFile: paths.projectFile, fallback: "code" }), "native");
});

test("reload shutdown restores before pending session_start and fresh post-bind capture", () => {
	const harness = createFakePi(["read", "bash"]);
	installHarness(harness);
	startAndCapture(harness);
	assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);

	harness.handlers.get("session_shutdown")?.(
		{ type: "session_shutdown", reason: "reload" },
		harness.ctx,
	);
	assert.deepEqual(harness.physicalActive(), ["read", "bash"]);
	harness.handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, harness.ctx);
	assert.deepEqual(harness.physicalActive(), ["read", "bash"]);
	harness.captureRuntime();
	assert.deepEqual(harness.physicalActive(), [TRANSPORT_NAME]);
	assert.deepEqual(harness.notifications, []);
	assert.deepEqual(harness.statuses, ["ptc: code", "ptc: code"]);
});

test("failed ptc details are patched once by call id and cleared on shutdown", async () => {
	const harness = createFakePi(["read", "bash", "ls"]);
	installHarness(harness);
	const tool = harness.tools.get(TRANSPORT_NAME);
	assert.ok(tool);

	const executeFailure = (toolCallId: string) =>
		assert.rejects(
			tool.execute(
				toolCallId,
				{ code: FAILURE_PROGRAM, description: FAILURE_DESCRIPTION },
				undefined,
				undefined,
				harness.ctx,
			),
			new RegExp(OUTER_FAILURE_MESSAGE),
		);
	await executeFailure(FAILURE_TOOL_CALL_ID);

	const toolResult = harness.handlers.get("tool_result");
	assert.ok(toolResult);
	assert.equal(
		toolResult({ toolName: TRANSPORT_NAME, toolCallId: MISSING_TOOL_CALL_ID }, harness.ctx),
		undefined,
	);
	const patch = toolResult(
		{ toolName: TRANSPORT_NAME, toolCallId: FAILURE_TOOL_CALL_ID },
		harness.ctx,
	) as { details: PtcDispatchDetails };
	assert.equal(Object.hasOwn(patch, "content"), false);
	assert.equal(patch.details.schemaVersion, 2);
	assert.equal(patch.details.mode, "snapshot");
	assert.equal(patch.details.dispatches.length, 1);
	assert.equal(patch.details.dispatches[0]?.status, "ok");
	assert.match(patch.details.executionError ?? "", new RegExp(OUTER_FAILURE_MESSAGE));
	assert.equal(JSON.stringify(patch.details).includes(FAILURE_PROGRAM), false);
	assert.equal(
		toolResult({ toolName: TRANSPORT_NAME, toolCallId: FAILURE_TOOL_CALL_ID }, harness.ctx),
		undefined,
	);

	await executeFailure(SHUTDOWN_TOOL_CALL_ID);
	harness.handlers.get("session_shutdown")?.({}, harness.ctx);
	assert.equal(
		toolResult({ toolName: TRANSPORT_NAME, toolCallId: SHUTDOWN_TOOL_CALL_ID }, harness.ctx),
		undefined,
	);
});

test("failure handoff is isolated between installers with the same call id", async () => {
	const first = createFakePi(["read", "bash", "ls"]);
	const second = createFakePi(["read", "bash", "ls"]);
	installHarness(first);
	installHarness(second);
	const firstTool = first.tools.get(TRANSPORT_NAME);
	const secondTool = second.tools.get(TRANSPORT_NAME);
	const firstToolResult = first.handlers.get("tool_result");
	const secondToolResult = second.handlers.get("tool_result");
	assert.ok(firstTool);
	assert.ok(secondTool);
	assert.ok(firstToolResult);
	assert.ok(secondToolResult);

	await assert.rejects(
		firstTool.execute(
			SHARED_TOOL_CALL_ID,
			{ code: FIRST_FAILURE_PROGRAM, description: FIRST_FAILURE_DESCRIPTION },
			undefined,
			undefined,
			first.ctx,
		),
		new RegExp(FIRST_OUTER_FAILURE_MESSAGE),
	);
	await assert.rejects(
		secondTool.execute(
			SHARED_TOOL_CALL_ID,
			{ code: SECOND_FAILURE_PROGRAM, description: SECOND_FAILURE_DESCRIPTION },
			undefined,
			undefined,
			second.ctx,
		),
		new RegExp(SECOND_OUTER_FAILURE_MESSAGE),
	);

	const firstPatch = firstToolResult(
		{ toolName: TRANSPORT_NAME, toolCallId: SHARED_TOOL_CALL_ID },
		first.ctx,
	) as { details: PtcDispatchDetails };
	assert.match(firstPatch.details.executionError ?? "", new RegExp(FIRST_OUTER_FAILURE_MESSAGE));
	assert.equal(
		firstToolResult({ toolName: TRANSPORT_NAME, toolCallId: SHARED_TOOL_CALL_ID }, first.ctx),
		undefined,
	);
	const secondPatch = secondToolResult(
		{ toolName: TRANSPORT_NAME, toolCallId: SHARED_TOOL_CALL_ID },
		second.ctx,
	) as { details: PtcDispatchDetails };
	assert.match(secondPatch.details.executionError ?? "", new RegExp(SECOND_OUTER_FAILURE_MESSAGE));
	assert.equal(
		secondToolResult({ toolName: TRANSPORT_NAME, toolCallId: SHARED_TOOL_CALL_ID }, second.ctx),
		undefined,
	);

	await assert.rejects(
		firstTool.execute(
			SHARED_TOOL_CALL_ID,
			{ code: FIRST_FAILURE_PROGRAM, description: FIRST_FAILURE_DESCRIPTION },
			undefined,
			undefined,
			first.ctx,
		),
		new RegExp(FIRST_OUTER_FAILURE_MESSAGE),
	);
	await assert.rejects(
		secondTool.execute(
			SHARED_TOOL_CALL_ID,
			{ code: SECOND_FAILURE_PROGRAM, description: SECOND_FAILURE_DESCRIPTION },
			undefined,
			undefined,
			second.ctx,
		),
		new RegExp(SECOND_OUTER_FAILURE_MESSAGE),
	);
	first.handlers.get("session_shutdown")?.({}, first.ctx);
	assert.equal(
		firstToolResult({ toolName: TRANSPORT_NAME, toolCallId: SHARED_TOOL_CALL_ID }, first.ctx),
		undefined,
	);
	const survivingPatch = secondToolResult(
		{ toolName: TRANSPORT_NAME, toolCallId: SHARED_TOOL_CALL_ID },
		second.ctx,
	) as { details: PtcDispatchDetails };
	assert.match(
		survivingPatch.details.executionError ?? "",
		new RegExp(SECOND_OUTER_FAILURE_MESSAGE),
	);
});

test("before_agent_start injects sdk and restores skills when read is hidden", async () => {
	const harness = createFakePi(["read", "bash", "mcp"]);
	installHarness(harness);
	startAndCapture(harness);
	const result = (await harness.emitBeforeAgentStart("prompt", {
		skills: [
			{
				name: "demo",
				description: "demo skill",
				filePath: "/tmp/demo/SKILL.md",
				disableModelInvocation: false,
			},
		],
	})) as { systemPrompt: string };
	assert.match(result.systemPrompt, /await tools\.read\(/);
	assert.match(result.systemPrompt, /tools\.read/);
	assert.match(result.systemPrompt, /<name>demo<\/name>/);
});
