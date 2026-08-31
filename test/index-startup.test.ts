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
	installPiRuntimeCapturePatch,
	type PiRuntimePatchInstallation,
} from "../src/pi-runtime.ts";
import {
	COMPETING_TOOL_NAME,
	createFakePi,
	type EventHandler,
	REAL_CHARACTERIZATION_DIRECTORY_PREFIX,
	REAL_INITIAL_OWNER_DIRECTORY_PREFIX,
	tempPaths,
} from "./support/index-harness.ts";

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

test("real Pi initial competing owner deactivates only the auto-activated owned ptc", async () => {
	const directory = mkdtempSync(join(tmpdir(), REAL_INITIAL_OWNER_DIRECTORY_PREFIX));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const notifications: string[] = [];
	const statuses: string[] = [];
	const installations: PiRuntimePatchInstallation[] = [];
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [
			{
				name: "initial-owner",
				factory(pi) {
					pi.registerTool(
						defineTool({
							name: COMPETING_TOOL_NAME,
							label: "Initial competing owner",
							description: "Owns code-mode presentation before pi-ptc binds",
							parameters: Type.Object({}),
							execute: async () => ({ content: [], details: undefined }),
						}),
					);
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
						installRuntimeCapture() {
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

		assert.deepEqual(session.getActiveToolNames(), ["read", COMPETING_TOOL_NAME]);
		assert.equal(
			session.getAllTools().some((tool) => tool.name === TRANSPORT_NAME),
			true,
		);
		assert.equal(
			session.getAllTools().some((tool) => tool.name === COMPETING_TOOL_NAME),
			true,
		);
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
