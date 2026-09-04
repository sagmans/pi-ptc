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
} from "../src/pi-runtime.ts";
import {
	COMPETING_TOOL_NAME,
	type EventHandler,
	LATE_OWNER_SYSTEM_PROMPT,
	LATE_OWNER_TOOL_CALL_ID,
	REAL_LATE_OWNER_DIRECTORY_PREFIX,
	REAL_RELOAD_DIRECTORY_PREFIX,
	SHUTDOWN_REFRESH_TOOL_NAME,
} from "./support/index-harness.ts";

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
