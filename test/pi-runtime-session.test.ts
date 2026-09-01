import {
	assert,
	assertCompatible,
	assertFacadeAssociation,
	assertIncompatible,
	assertRegistryNames,
	assertStale,
	CHARACTERIZATION_TOOL_CALL_ID,
	createDeferred,
	createFakeSessionClass,
	createInstaller,
	createRunner,
	createTool,
	EXPECTED_CAPTURE_COUNT,
	EXPECTED_REBIND_CAPTURE_COUNT,
	installPiRuntimeCapturePatch,
	ORIGINAL_ERROR,
	ORIGINAL_RESULT,
	type PiRuntimeCapture,
	PTC_TOOL_NAME,
	RELOAD_RESULT,
	SAMPLE_TOOL_NAME,
	SECOND_TOOL_NAME,
	STALE_CAPTURE_PATTERN,
	SUPPORTED_PI_VERSION,
	tagPtcToolDefinition,
	test,
} from "./support/pi-runtime-harness.ts";

test("reload replaces capture and makes the prior generation stale", async () => {
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const replacementRunner = createRunner();
	const replacementRegistry = new Map([[SECOND_TOOL_NAME, createTool()]]);
	const replacementDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
	const { Session, reloadEvents } = createFakeSessionClass({
		onReload(session) {
			session.extensionRunner = replacementRunner;
			session._toolRegistry = replacementRegistry;
			session.ptcDefinition = replacementDefinition;
		},
	});
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	const session = new Session();
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
	await session.bindExtensions();
	const firstAdapter = assertCompatible(captures[0]);

	const result = await session.reload();

	assert.equal(result, RELOAD_RESULT);
	assert.deepEqual(reloadEvents, ["original"]);
	assert.equal(captures.length, EXPECTED_REBIND_CAPTURE_COUNT);
	assertStale(firstAdapter);
	const replacementAdapter = assertCompatible(captures[1]);
	assertFacadeAssociation(replacementAdapter, session);
	assertRegistryNames(replacementAdapter, replacementRegistry);
	assert.equal(replacementAdapter.getToolDefinition(PTC_TOOL_NAME), replacementDefinition);
	installation.teardown();
});

test("retained capability facades reject after reload without invoking raw capabilities", async () => {
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const rawCalls = {
		createContext: 0,
		emit: 0,
		getActiveTools: 0,
		setActiveTools: 0,
		refreshTools: 0,
		prepareArguments: 0,
		execute: 0,
		beforeToolCall: 0,
		afterToolCall: 0,
	};
	const { Session } = createFakeSessionClass({
		onReload(session) {
			session.extensionRunner = createRunner();
			session._toolRegistry = new Map([[SECOND_TOOL_NAME, createTool()]]);
			session.agent.beforeToolCall = async () => undefined;
			session.agent.afterToolCall = async () => undefined;
			session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
		},
	});
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	const session = new Session();
	const rawRunner = session.extensionRunner;
	const rawRuntime = rawRunner.runtime;
	const rawTool = session._toolRegistry.get(SAMPLE_TOOL_NAME);
	assert.ok(rawTool);
	rawRunner.createContext = () => {
		rawCalls.createContext += 1;
		return {};
	};
	rawRunner.emit = async () => {
		rawCalls.emit += 1;
	};
	rawRuntime.getActiveTools = () => {
		rawCalls.getActiveTools += 1;
		return [SAMPLE_TOOL_NAME];
	};
	rawRuntime.setActiveTools = () => {
		rawCalls.setActiveTools += 1;
	};
	rawRuntime.refreshTools = () => {
		rawCalls.refreshTools += 1;
	};
	rawTool.prepareArguments = (args) => {
		rawCalls.prepareArguments += 1;
		return args;
	};
	rawTool.execute = async () => {
		rawCalls.execute += 1;
		return {};
	};
	session.agent.beforeToolCall = async () => {
		rawCalls.beforeToolCall += 1;
	};
	session.agent.afterToolCall = async () => {
		rawCalls.afterToolCall += 1;
	};
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
	await session.bindExtensions();
	const adapter = assertCompatible(captures[0]);
	const runner = adapter.extensionRunner;
	const runtime = adapter.sharedRuntime;
	const registry = adapter.toolRegistry;
	const tool = registry.get(SAMPLE_TOOL_NAME);
	assert.ok(tool);
	const beforeToolCall = adapter.beforeToolCall;
	const afterToolCall = adapter.afterToolCall;
	const getToolDefinition = adapter.getToolDefinition;
	const retainedEntries = registry.entries();

	await session.reload();

	const staleOperations = [
		() => runner.createContext(),
		() => runner.emit({ type: "agent_settled" }),
		() => runtime.getActiveTools(),
		() => runtime.setActiveTools([]),
		() => runtime.refreshTools(),
		() => registry.size,
		() => registry.get(SAMPLE_TOOL_NAME),
		() => registry.has(SAMPLE_TOOL_NAME),
		() => registry.forEach(() => {}),
		() => registry.entries(),
		() => registry.keys(),
		() => registry.values(),
		() => registry[Symbol.iterator](),
		() => retainedEntries.next(),
		() => tool.parameters,
		() => tool.executionMode,
		() => tool.prepareArguments,
		() => tool.execute(CHARACTERIZATION_TOOL_CALL_ID, {}),
		() => beforeToolCall({}),
		() => afterToolCall({}),
		() => getToolDefinition(PTC_TOOL_NAME),
	];
	for (const operation of staleOperations) {
		assert.throws(operation, STALE_CAPTURE_PATTERN);
	}
	assert.deepEqual(rawCalls, {
		createContext: 0,
		emit: 0,
		getActiveTools: 0,
		setActiveTools: 0,
		refreshTools: 0,
		prepareArguments: 0,
		execute: 0,
		beforeToolCall: 0,
		afterToolCall: 0,
	});
	installation.teardown();
});

test("retained capability facades reject after teardown", async () => {
	const { Session } = createFakeSessionClass();
	const captures: PiRuntimeCapture[] = [];
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	if (!installation.compatible) throw new Error("expected compatible installation");
	const session = new Session();
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, createInstaller(captures));
	await session.bindExtensions();
	const adapter = assertCompatible(captures[0]);
	const runner = adapter.extensionRunner;
	const runtime = adapter.sharedRuntime;
	const registry = adapter.toolRegistry;
	const tool = registry.get(SAMPLE_TOOL_NAME);
	assert.ok(tool);
	const beforeToolCall = adapter.beforeToolCall;
	const afterToolCall = adapter.afterToolCall;
	const eventInstallation = adapter.installRuntimeEventFinalizers({
		finalizeToolCall: async (_args, result) => result,
		finalizeBeforeAgentStart: async (_args, result) => result,
	});
	const installedEmitToolCall = session.extensionRunner.emitToolCall;
	const installedEmitBeforeAgentStart = session.extensionRunner.emitBeforeAgentStart;

	installation.teardown();

	for (const operation of [
		() => runner.createContext(),
		() => runtime.getActiveTools(),
		() => registry.get(SAMPLE_TOOL_NAME),
		() => tool.execute(CHARACTERIZATION_TOOL_CALL_ID, {}),
		() => beforeToolCall({}),
		() => afterToolCall({}),
	]) {
		assert.throws(operation, STALE_CAPTURE_PATTERN);
	}
	await assert.rejects(
		Reflect.apply(installedEmitToolCall, session.extensionRunner, [{}]),
		STALE_CAPTURE_PATTERN,
	);
	await assert.rejects(
		Reflect.apply(installedEmitBeforeAgentStart, session.extensionRunner, [
			"prompt",
			undefined,
			"system",
			{},
		]),
		STALE_CAPTURE_PATTERN,
	);
	eventInstallation.restore();
});

test("tag removal and invalid rebinding leave earlier generations stale", async () => {
	const { Session } = createFakeSessionClass();
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	const session = new Session();
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
	await session.bindExtensions();
	const taggedAdapter = assertCompatible(captures[0]);

	session.ptcDefinition = { name: PTC_TOOL_NAME };
	await session.bindExtensions();

	assert.equal(captures.length, EXPECTED_CAPTURE_COUNT);
	assertStale(taggedAdapter);

	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
	await session.bindExtensions();
	const reboundAdapter = assertCompatible(captures[1]);
	(session.extensionRunner as unknown as { emit: unknown }).emit = undefined;

	await session.bindExtensions();

	assert.equal(captures.length, EXPECTED_REBIND_CAPTURE_COUNT + EXPECTED_CAPTURE_COUNT);
	assertIncompatible(captures[2], /emit/);
	assertStale(reboundAdapter);
	installation.teardown();
});

test("older bind success invalidates a newer reload capture instead of retargeting it", async () => {
	const olderGate = createDeferred();
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const olderRunner = createRunner();
	const olderRegistry = new Map([[SAMPLE_TOOL_NAME, createTool()]]);
	const newerRunner = createRunner();
	const newerRegistry = new Map([[SECOND_TOOL_NAME, createTool()]]);
	const { Session } = createFakeSessionClass({
		async onBind(session) {
			await olderGate.promise;
			session.extensionRunner = olderRunner;
			session._toolRegistry = olderRegistry;
			session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
		},
		onReload(session) {
			session.extensionRunner = newerRunner;
			session._toolRegistry = newerRegistry;
			session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
		},
	});
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	const session = new Session();
	const olderBind = session.bindExtensions();

	assert.equal(await session.reload(), RELOAD_RESULT);
	assert.equal(captures.length, EXPECTED_CAPTURE_COUNT);
	const newerAdapter = assertCompatible(captures[0]);
	assertFacadeAssociation(newerAdapter, session);
	assertRegistryNames(newerAdapter, newerRegistry);

	olderGate.resolve();
	assert.equal(await olderBind, ORIGINAL_RESULT);

	assert.equal(captures.length, EXPECTED_CAPTURE_COUNT);
	assertStale(newerAdapter);
	installation.teardown();
});

test("older bind rejection invalidates a newer reload capture", async () => {
	const olderGate = createDeferred();
	const rejection = new Error(ORIGINAL_ERROR);
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const { Session } = createFakeSessionClass({
		async onBind(session) {
			await olderGate.promise;
			session.extensionRunner = createRunner();
			session._toolRegistry = new Map([[SAMPLE_TOOL_NAME, createTool()]]);
			throw rejection;
		},
		onReload(session) {
			session.extensionRunner = createRunner();
			session._toolRegistry = new Map([[SECOND_TOOL_NAME, createTool()]]);
			session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
		},
	});
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	const session = new Session();
	const olderBind = session.bindExtensions();

	await session.reload();
	const newerAdapter = assertCompatible(captures[0]);
	assertFacadeAssociation(newerAdapter, session);

	olderGate.resolve();
	await assert.rejects(olderBind, (error) => error === rejection);

	assert.equal(captures.length, EXPECTED_CAPTURE_COUNT);
	assertStale(newerAdapter);
	installation.teardown();
});
