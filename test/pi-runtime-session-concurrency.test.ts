import {
	assert,
	assertCompatible,
	assertFacadeAssociation,
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
	type FakeSessionShape,
	type FakeTool,
	installPiRuntimeCapturePatch,
	ORIGINAL_RESULT,
	type PiRuntimeCapture,
	type PiRuntimeInstaller,
	PTC_TOOL_NAME,
	RELOAD_RESULT,
	SAMPLE_TOOL_NAME,
	SECOND_TOOL_NAME,
	STALE_CAPTURE_PATTERN,
	SUPPORTED_PI_VERSION,
	tagPtcToolDefinition,
	test,
} from "./support/pi-runtime-harness.ts";

test("older completion leaves a newer in-flight invocation able to publish", async () => {
	const olderGate = createDeferred();
	const newerGate = createDeferred();
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const newerRunner = createRunner();
	const newerRegistry = new Map([[SECOND_TOOL_NAME, createTool()]]);
	const { Session } = createFakeSessionClass({
		async onBind(session) {
			await olderGate.promise;
			session.extensionRunner = createRunner();
			session._toolRegistry = new Map([[SAMPLE_TOOL_NAME, createTool()]]);
		},
		async onReload(session) {
			await newerGate.promise;
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
	const newerReload = session.reload();

	olderGate.resolve();
	assert.equal(await olderBind, ORIGINAL_RESULT);
	assert.deepEqual(captures, []);

	newerGate.resolve();
	assert.equal(await newerReload, RELOAD_RESULT);
	const newerAdapter = assertCompatible(captures[0]);
	assertFacadeAssociation(newerAdapter, session);
	assertRegistryNames(newerAdapter, newerRegistry);
	installation.teardown();
});

test("old patch completion invalidates a newer capture after teardown and reinstall", async () => {
	const olderGate = createDeferred();
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const olderRunner = createRunner();
	const olderRegistry = new Map([[SAMPLE_TOOL_NAME, createTool()]]);
	const newerRunner = createRunner();
	const newerRegistry = new Map([[SECOND_TOOL_NAME, createTool()]]);
	let bindCalls = 0;
	const { Session } = createFakeSessionClass({
		async onBind(session) {
			bindCalls += 1;
			if (bindCalls === EXPECTED_CAPTURE_COUNT) return;
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
	const firstInstallation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(firstInstallation.compatible, true);
	if (!firstInstallation.compatible) throw new Error("expected compatible installation");
	const session = new Session();
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
	await session.bindExtensions();
	const oldAdapter = assertCompatible(captures[0]);

	const olderBind = session.bindExtensions();
	assertStale(oldAdapter);
	firstInstallation.teardown();
	assertStale(oldAdapter);

	const secondInstallation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(secondInstallation.compatible, true);
	if (!secondInstallation.compatible) throw new Error("expected compatible reinstallation");
	await session.reload();
	assert.equal(captures.length, EXPECTED_REBIND_CAPTURE_COUNT);
	const newAdapter = assertCompatible(captures[1]);
	assertFacadeAssociation(newAdapter, session);
	assertRegistryNames(newAdapter, newerRegistry);

	olderGate.resolve();
	assert.equal(await olderBind, ORIGINAL_RESULT);

	assert.equal(captures.length, EXPECTED_REBIND_CAPTURE_COUNT);
	assertStale(oldAdapter);
	assertStale(newAdapter);
	secondInstallation.teardown();
});

test("adapter invalidates when captured generation identities or tag change", async () => {
	const cases: Array<{
		name: string;
		mutate(session: FakeSessionShape, installer: PiRuntimeInstaller): void;
	}> = [
		{
			name: "extension runner",
			mutate: (session) => {
				session.extensionRunner = createRunner();
			},
		},
		{
			name: "shared runtime",
			mutate: (session) => {
				session.extensionRunner.runtime = createRunner().runtime;
			},
		},
		{
			name: "tool registry",
			mutate: (session) => {
				session._toolRegistry = new Map([[SECOND_TOOL_NAME, createTool()]]);
			},
		},
		{
			name: "before hook",
			mutate: (session) => {
				session.agent.beforeToolCall = async () => undefined;
			},
		},
		{
			name: "after hook",
			mutate: (session) => {
				session.agent.afterToolCall = async () => undefined;
			},
		},
		{
			name: "tool lookup",
			mutate: (session) => {
				session.getToolDefinition = (name) =>
					name === PTC_TOOL_NAME ? session.ptcDefinition : undefined;
			},
		},
		{
			name: "tagged definition",
			mutate: (session, installer) => {
				session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
			},
		},
		{
			name: "installer tag",
			mutate: (session) => {
				assert.ok(session.ptcDefinition);
				tagPtcToolDefinition(session.ptcDefinition, createInstaller([]));
			},
		},
	];

	for (const testCase of cases) {
		const captures: PiRuntimeCapture[] = [];
		const installer = createInstaller(captures);
		const { Session } = createFakeSessionClass();
		const installation = installPiRuntimeCapturePatch({
			agentSession: Session,
			version: SUPPORTED_PI_VERSION,
		});
		assert.equal(installation.compatible, true, testCase.name);
		const session = new Session();
		session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
		await session.bindExtensions();
		const adapter = assertCompatible(captures[0]);

		testCase.mutate(session, installer);

		assertStale(adapter);
		assertStale(adapter);
		installation.teardown();
	}
});

test("adapter stales when a captured registry entry or field mutates in place", async () => {
	const cases: Array<{
		name: string;
		mutate(registry: Map<string, FakeTool>, tool: FakeTool): void;
	}> = [
		{
			name: "entry identity",
			mutate: (registry) => {
				registry.set(SAMPLE_TOOL_NAME, createTool());
			},
		},
		{
			name: "parameters identity",
			mutate: (_registry, tool) => {
				tool.parameters = { changed: true };
			},
		},
		{
			name: "prepareArguments identity",
			mutate: (_registry, tool) => {
				tool.prepareArguments = () => ({ changed: true });
			},
		},
		{
			name: "executionMode value",
			mutate: (_registry, tool) => {
				tool.executionMode = "sequential";
			},
		},
		{
			name: "execute identity",
			mutate: (_registry, tool) => {
				tool.execute = async () => ({ changed: true });
			},
		},
		{
			name: "registry membership",
			mutate: (registry) => {
				registry.set(SECOND_TOOL_NAME, createTool());
			},
		},
	];

	for (const testCase of cases) {
		const { Session } = createFakeSessionClass();
		const captures: PiRuntimeCapture[] = [];
		const installation = installPiRuntimeCapturePatch({
			agentSession: Session,
			version: SUPPORTED_PI_VERSION,
		});
		assert.equal(installation.compatible, true, testCase.name);
		const session = new Session();
		session.ptcDefinition = tagPtcToolDefinition(
			{ name: PTC_TOOL_NAME },
			createInstaller(captures),
		);
		await session.bindExtensions();
		const adapter = assertCompatible(captures[0]);
		const facadeTool = adapter.toolRegistry.get(SAMPLE_TOOL_NAME);
		const rawTool = session._toolRegistry.get(SAMPLE_TOOL_NAME);
		assert.ok(facadeTool, testCase.name);
		assert.ok(rawTool, testCase.name);

		testCase.mutate(session._toolRegistry, rawTool);

		assertStale(adapter);
		assert.throws(
			() => facadeTool.execute(CHARACTERIZATION_TOOL_CALL_ID, {}),
			STALE_CAPTURE_PATTERN,
		);
		installation.teardown();
	}
});

test("adapter stales when captured owner methods mutate in place", async () => {
	const cases: Array<{
		name: string;
		mutate(session: FakeSessionShape): void;
	}> = [
		{
			name: "runner createContext",
			mutate: (session) => {
				session.extensionRunner.createContext = () => ({ changed: true });
			},
		},
		{
			name: "runner emit",
			mutate: (session) => {
				session.extensionRunner.emit = async () => undefined;
			},
		},
		{
			name: "runtime getActiveTools",
			mutate: (session) => {
				session.extensionRunner.runtime.getActiveTools = () => [];
			},
		},
		{
			name: "runtime setActiveTools",
			mutate: (session) => {
				session.extensionRunner.runtime.setActiveTools = () => undefined;
			},
		},
		{
			name: "runtime refreshTools",
			mutate: (session) => {
				session.extensionRunner.runtime.refreshTools = () => undefined;
			},
		},
	];

	for (const testCase of cases) {
		const { Session } = createFakeSessionClass();
		const captures: PiRuntimeCapture[] = [];
		const installation = installPiRuntimeCapturePatch({
			agentSession: Session,
			version: SUPPORTED_PI_VERSION,
		});
		assert.equal(installation.compatible, true, testCase.name);
		const session = new Session();
		session.ptcDefinition = tagPtcToolDefinition(
			{ name: PTC_TOOL_NAME },
			createInstaller(captures),
		);
		await session.bindExtensions();
		const adapter = assertCompatible(captures[0]);

		testCase.mutate(session);

		assertStale(adapter);
		installation.teardown();
	}
});
