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

import { TRANSPORT_NAME } from "../src/config.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/host.ts";
import installPtc from "../src/index.ts";
import {
	type CapturedPiSession,
	installPiRuntimeCapturePatch,
	type PiRuntimePatchInstallation,
	SUPPORTED_PI_VERSION,
} from "../src/pi-runtime.ts";
import {
	COMPETING_TOOL_NAME,
	type EventHandler,
	REAL_LATE_OWNER_DIRECTORY_PREFIX,
	tempPaths,
} from "./support/index-harness.ts";

test("tagged private-shape incompatibility deactivates the owned ptc before catalog capture", async () => {
	const definitions = new Map<string, object>([["read", { name: "read" }]]);
	let physical = ["read"];
	const notifications: string[] = [];
	const statuses: string[] = [];
	const handlers = new Map<string, EventHandler>();
	let installation: PiRuntimePatchInstallation | undefined;
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
	class ShapeDriftSession {
		agent = {
			beforeToolCall: async () => undefined,
			afterToolCall: async () => undefined,
		};
		extensionRunner = {
			createContext: () => ctx,
			emit: async () => undefined,
			emitToolCall: async () => undefined,
			emitBeforeAgentStart: async () => undefined,
			runtime: {
				getActiveTools: () => [...physical],
				setActiveTools: (names: string[]) => {
					physical = [...names];
				},
				refreshTools: () => undefined,
			},
		};

		getToolDefinition(name: string): object | undefined {
			return definitions.get(name);
		}

		async bindExtensions(): Promise<void> {}
		async reload(): Promise<void> {}
	}
	const pi: ExtensionAPI = {
		registerTool(definition) {
			definitions.set(definition.name, definition);
			if (!physical.includes(definition.name)) physical.push(definition.name);
		},
		registerCommand() {},
		on(event, handler) {
			handlers.set(event, handler as EventHandler);
		},
		setActiveTools(names) {
			physical = [...names];
		},
		getActiveTools() {
			return [...physical];
		},
		getAllTools() {
			return [...definitions.keys()].map((name) => ({ name }));
		},
		appendEntry() {},
		events: { emit() {} },
	};
	installPtc(pi, {
		resolvePaths: tempPaths,
		installRuntimeCapture() {
			installation = installPiRuntimeCapturePatch({
				agentSession: ShapeDriftSession,
				version: SUPPORTED_PI_VERSION,
			});
			return installation;
		},
	});
	const session = new ShapeDriftSession();

	try {
		handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		assert.deepEqual(physical, ["read", TRANSPORT_NAME]);
		await session.bindExtensions();

		assert.deepEqual(physical, ["read"]);
		assert.equal(definitions.has(TRANSPORT_NAME), true);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0] ?? "", /_toolRegistry|inert/i);
		assert.deepEqual(statuses, ["ptc: inert"]);
	} finally {
		if (installation?.compatible) installation.teardown();
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
