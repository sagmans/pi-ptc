import {
	AgentSession,
	assert,
	assertCompatible,
	assertStale,
	BIND_EXTENSIONS_PROPERTY,
	CHARACTERIZATION_DIRECTORY_PREFIX,
	CHARACTERIZATION_TOOL_CALL_ID,
	CHARACTERIZATION_TOOL_RESULT,
	createAgentSession,
	createInstaller,
	DefaultResourceLoader,
	defineTool,
	EXPECTED_CAPTURE_COUNT,
	EXPECTED_REBIND_CAPTURE_COUNT,
	installPiRuntimeCapturePatch,
	join,
	ModelRuntime,
	mkdirSync,
	mkdtempSync,
	PACKAGE_JSON_PATH,
	PACKAGE_LOCK_PATH,
	type PiRuntimeCapture,
	PTC_TOOL_NAME,
	RELOAD_PROPERTY,
	readFileSync,
	rmSync,
	SessionManager,
	SettingsManager,
	SUPPORTED_PI_VERSION,
	Type,
	tagPtcToolDefinition,
	test,
	tmpdir,
	VERSION,
} from "./support/pi-runtime-harness.ts";

test("installed Pi exports exact patchable bind and reload runtime methods", () => {
	assert.equal(VERSION, SUPPORTED_PI_VERSION);
	for (const property of [BIND_EXTENSIONS_PROPERTY, RELOAD_PROPERTY]) {
		const descriptor = Object.getOwnPropertyDescriptor(AgentSession.prototype, property);
		assert.ok(descriptor, property);
		assert.equal(typeof descriptor.value, "function", property);
		assert.equal(descriptor.configurable === true || descriptor.writable === true, true, property);
	}
});

test("real Pi 0.84.3 session_start precedes tagged post-bind capture", async () => {
	const directory = mkdtempSync(join(tmpdir(), CHARACTERIZATION_DIRECTORY_PREFIX));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const captures: PiRuntimeCapture[] = [];
	let emittedEvents = 0;
	let beforeHookCalls = 0;
	let afterHookCalls = 0;
	let toolExecutions = 0;
	const captureCountsAtSessionStart: number[] = [];
	const installer = createInstaller(captures);
	const definition = tagPtcToolDefinition(
		defineTool({
			name: PTC_TOOL_NAME,
			label: "PTC characterization",
			description: "Characterize the tagged Pi runtime contract",
			parameters: Type.Object({}),
			prepareArguments: () => ({}),
			executionMode: "parallel",
			execute: async () => {
				toolExecutions += 1;
				return {
					content: [{ type: "text", text: CHARACTERIZATION_TOOL_RESULT }],
					details: undefined,
				};
			},
		}),
		installer,
	);
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [
			{
				name: "ptc-characterization",
				factory(pi) {
					pi.registerTool(definition);
					pi.on("session_start", () => {
						captureCountsAtSessionStart.push(captures.length);
					});
					pi.on("agent_settled", () => {
						emittedEvents += 1;
					});
					pi.on("tool_call", () => {
						beforeHookCalls += 1;
					});
					pi.on("tool_result", () => {
						afterHookCalls += 1;
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
	const installation = installPiRuntimeCapturePatch();
	assert.equal(installation.compatible, true);
	if (!installation.compatible) throw new Error("expected compatible installation");

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
			tools: [PTC_TOOL_NAME],
		});

		await session.bindExtensions({ mode: "print" });

		assert.deepEqual(captureCountsAtSessionStart, [0]);
		assert.equal(captures.length, EXPECTED_CAPTURE_COUNT);
		const adapter = assertCompatible(captures[0]);
		assert.equal(adapter.getToolDefinition(PTC_TOOL_NAME), definition);
		const context = adapter.extensionRunner.createContext() as { cwd: string };
		assert.equal(context.cwd, cwd);
		await adapter.extensionRunner.emit({ type: "agent_settled" });
		assert.equal(emittedEvents, EXPECTED_CAPTURE_COUNT);
		const activeTools = adapter.sharedRuntime.getActiveTools();
		assert.deepEqual(activeTools, [PTC_TOOL_NAME]);
		adapter.sharedRuntime.setActiveTools(activeTools);
		const tool = adapter.toolRegistry.get(PTC_TOOL_NAME);
		assert.ok(tool);
		assert.equal(adapter.toolRegistry.size, EXPECTED_CAPTURE_COUNT);
		assert.equal(tool.parameters, definition.parameters);
		assert.equal(tool.executionMode, "parallel");
		assert.deepEqual(tool.prepareArguments?.({}), {});
		const toolResult = (await tool.execute(CHARACTERIZATION_TOOL_CALL_ID, {})) as {
			content: Array<{ type: string; text: string }>;
		};
		assert.equal(toolResult.content[0]?.text, CHARACTERIZATION_TOOL_RESULT);
		assert.equal(toolExecutions, EXPECTED_CAPTURE_COUNT);
		await adapter.beforeToolCall({
			toolCall: { id: CHARACTERIZATION_TOOL_CALL_ID, name: PTC_TOOL_NAME },
			args: {},
		});
		await adapter.afterToolCall({
			toolCall: { id: CHARACTERIZATION_TOOL_CALL_ID, name: PTC_TOOL_NAME },
			args: {},
			result: { content: [], details: undefined },
			isError: false,
		});
		assert.equal(beforeHookCalls, EXPECTED_CAPTURE_COUNT);
		assert.equal(afterHookCalls, EXPECTED_CAPTURE_COUNT);
		adapter.sharedRuntime.refreshTools();
		assertStale(adapter);
	} finally {
		installation.teardown();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("real Pi reload session_start sees prior capture before fresh post-reload capture", async () => {
	const directory = mkdtempSync(join(tmpdir(), CHARACTERIZATION_DIRECTORY_PREFIX));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const captures: PiRuntimeCapture[] = [];
	const captureCountsAtSessionStart: number[] = [];
	const installer = createInstaller(captures);
	const definition = tagPtcToolDefinition(
		defineTool({
			name: PTC_TOOL_NAME,
			label: "PTC reload characterization",
			description: "Characterize capture ordering across reload",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: undefined }),
		}),
		installer,
	);
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [
			{
				name: "ptc-reload-characterization",
				factory(pi) {
					pi.registerTool(definition);
					pi.on("session_start", () => {
						captureCountsAtSessionStart.push(captures.length);
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
	const installation = installPiRuntimeCapturePatch();
	assert.equal(installation.compatible, true);
	if (!installation.compatible) throw new Error("expected compatible installation");

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
			tools: [PTC_TOOL_NAME],
		});
		const uiContext = {
			notify() {},
			setStatus() {},
		};

		await session.bindExtensions({ mode: "print", uiContext: uiContext as never });
		await session.reload();

		assert.deepEqual(captureCountsAtSessionStart, [0, EXPECTED_CAPTURE_COUNT]);
		assert.equal(captures.length, EXPECTED_REBIND_CAPTURE_COUNT);
		assertCompatible(captures[1]);
	} finally {
		installation.teardown();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("package metadata defers exact Pi support to the runtime bootstrap", () => {
	const manifest = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
		peerDependencies: Record<string, string>;
	};
	const lock = JSON.parse(readFileSync(PACKAGE_LOCK_PATH, "utf8")) as {
		packages: Record<string, { peerDependencies?: Record<string, string> }>;
	};
	assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
	assert.equal(lock.packages[""]?.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
});
