import {
	assert,
	assertCompatible,
	assertFacadeAssociation,
	assertRegistryNames,
	assertStale,
	createDeferred,
	createFakeSessionClass,
	createInstaller,
	createRunner,
	createTool,
	EXPECTED_CAPTURE_COUNT,
	EXPECTED_REBIND_CAPTURE_COUNT,
	installPiRuntimeCapturePatch,
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

test("runtime action installation validates all replacements before mutation", async () => {
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
	const runtime = session.extensionRunner.runtime;
	const originalActions = {
		getActiveTools: runtime.getActiveTools,
		setActiveTools: runtime.setActiveTools,
		refreshTools: runtime.refreshTools,
	};

	assert.throws(
		() =>
			adapter.installRuntimeActions({
				getActiveTools: () => [],
				setActiveTools: undefined,
				refreshTools: () => undefined,
			} as never),
		/replacement/i,
	);
	assert.deepEqual(
		{
			getActiveTools: runtime.getActiveTools,
			setActiveTools: runtime.setActiveTools,
			refreshTools: runtime.refreshTools,
		},
		originalActions,
	);
	Object.defineProperty(runtime, "getActiveTools", {
		value: originalActions.getActiveTools,
		configurable: false,
		writable: false,
	});
	assert.throws(
		() =>
			adapter.installRuntimeActions({
				getActiveTools: () => [],
				setActiveTools: () => undefined,
				refreshTools: () => undefined,
			}),
		/not patchable/i,
	);
	assert.equal(runtime.setActiveTools, originalActions.setActiveTools);
	assert.equal(runtime.refreshTools, originalActions.refreshTools);
	installation.teardown();
});

test("reload retains controlled adapter until shutdown restore and then publishes fresh capture", async () => {
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const replacementRunner = createRunner();
	const replacementRegistry = new Map([[SECOND_TOOL_NAME, createTool()]]);
	let adapter: ReturnType<typeof assertCompatible> | undefined;
	let runtimeInstallation:
		| ReturnType<ReturnType<typeof assertCompatible>["installRuntimeActions"]>
		| undefined;
	const calls: string[] = [];
	const { Session } = createFakeSessionClass({
		onReload(session) {
			assert.ok(adapter);
			assert.ok(runtimeInstallation);
			const active = adapter.sharedRuntime.getActiveTools();
			adapter.sharedRuntime.setActiveTools(active);
			adapter.sharedRuntime.refreshTools();
			calls.push(`retained:${active.join(",")}`);
			runtimeInstallation.restore([SAMPLE_TOOL_NAME]);
			assertStale(adapter);
			session.extensionRunner = replacementRunner;
			session._toolRegistry = replacementRegistry;
			session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
		},
	});
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	if (!installation.compatible) throw new Error("expected compatible installation");
	const session = new Session();
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
	await session.bindExtensions();
	adapter = assertCompatible(captures[0]);
	runtimeInstallation = adapter.installRuntimeActions({
		getActiveTools: () => [SAMPLE_TOOL_NAME, PTC_TOOL_NAME],
		setActiveTools: (names) => {
			calls.push(`set:${names.join(",")}`);
		},
		refreshTools: () => {
			calls.push("refresh");
		},
	});

	await session.reload();

	assert.deepEqual(calls, [
		`set:${SAMPLE_TOOL_NAME},${PTC_TOOL_NAME}`,
		"refresh",
		`retained:${SAMPLE_TOOL_NAME},${PTC_TOOL_NAME}`,
	]);
	assert.equal(captures.length, EXPECTED_REBIND_CAPTURE_COUNT);
	assertStale(adapter);
	const freshAdapter = assertCompatible(captures[1]);
	assertFacadeAssociation(freshAdapter, session);
	assertRegistryNames(freshAdapter, replacementRegistry);
	installation.teardown();
});

test("reload identity drift detaches retained access without consuming reload ownership", async () => {
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const replacementRunner = createRunner();
	const replacementRegistry = new Map([[SECOND_TOOL_NAME, createTool()]]);
	let adapter: ReturnType<typeof assertCompatible> | undefined;
	let activeBeforeDrift: string[] | undefined;
	const { Session } = createFakeSessionClass({
		onReload(session) {
			assert.ok(adapter);
			activeBeforeDrift = adapter.sharedRuntime.getActiveTools();
			session.extensionRunner = replacementRunner;
			session._toolRegistry = replacementRegistry;
			session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
			assertStale(adapter);
		},
	});
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	if (!installation.compatible) throw new Error("expected compatible installation");
	const session = new Session();
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
	await session.bindExtensions();
	adapter = assertCompatible(captures[0]);

	await session.reload();

	assert.deepEqual(activeBeforeDrift, [SAMPLE_TOOL_NAME]);
	assert.equal(captures.length, EXPECTED_REBIND_CAPTURE_COUNT);
	assertStale(adapter);
	const freshAdapter = assertCompatible(captures[1]);
	assertFacadeAssociation(freshAdapter, session);
	assertRegistryNames(freshAdapter, replacementRegistry);
	installation.teardown();
});

test("overlapping reloads retain only current invocation ownership", async () => {
	const firstGate = createDeferred();
	const secondGate = createDeferred();
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const firstRunner = createRunner();
	const secondRunner = createRunner();
	const firstRegistry = new Map([[SAMPLE_TOOL_NAME, createTool()]]);
	const secondRegistry = new Map([[SECOND_TOOL_NAME, createTool()]]);
	let reloadCount = 0;
	const { Session } = createFakeSessionClass({
		async onReload(session) {
			reloadCount += 1;
			const invocation = reloadCount;
			await (invocation === 1 ? firstGate.promise : secondGate.promise);
			session.extensionRunner = invocation === 1 ? firstRunner : secondRunner;
			session._toolRegistry = invocation === 1 ? firstRegistry : secondRegistry;
			session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
		},
	});
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	if (!installation.compatible) throw new Error("expected compatible installation");
	const session = new Session();
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
	await session.bindExtensions();
	const oldAdapter = assertCompatible(captures[0]);

	const firstReload = session.reload();
	assert.deepEqual(oldAdapter.sharedRuntime.getActiveTools(), [SAMPLE_TOOL_NAME]);
	const secondReload = session.reload();
	assert.deepEqual(oldAdapter.sharedRuntime.getActiveTools(), [SAMPLE_TOOL_NAME]);
	firstGate.resolve();
	assert.equal(await firstReload, RELOAD_RESULT);
	assertStale(oldAdapter);
	assert.equal(captures.length, EXPECTED_CAPTURE_COUNT);
	secondGate.resolve();
	assert.equal(await secondReload, RELOAD_RESULT);

	assert.equal(captures.length, EXPECTED_REBIND_CAPTURE_COUNT);
	const freshAdapter = assertCompatible(captures[1]);
	assertFacadeAssociation(freshAdapter, session);
	assertRegistryNames(freshAdapter, secondRegistry);
	installation.teardown();
});

test("controlled runtime originals stale after reload while cleanup restores the old runner", async () => {
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const { Session } = createFakeSessionClass({
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
	if (!installation.compatible) throw new Error("expected compatible installation");
	const session = new Session();
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
	await session.bindExtensions();
	const oldRuntime = session.extensionRunner.runtime;
	const originalIdentities = {
		getActiveTools: oldRuntime.getActiveTools,
		setActiveTools: oldRuntime.setActiveTools,
		refreshTools: oldRuntime.refreshTools,
	};
	const runtimeInstallation = assertCompatible(captures[0]).installRuntimeActions({
		getActiveTools: () => [SAMPLE_TOOL_NAME, PTC_TOOL_NAME],
		setActiveTools: () => undefined,
		refreshTools: () => undefined,
	});

	await session.reload();

	for (const operation of [
		() => runtimeInstallation.original.getActiveTools(),
		() => runtimeInstallation.original.setActiveTools([]),
		() => runtimeInstallation.original.refreshTools(),
		() => runtimeInstallation.original.snapshotTools(),
	]) {
		assert.throws(operation, STALE_CAPTURE_PATTERN);
	}
	runtimeInstallation.restore();
	assert.equal(oldRuntime.getActiveTools, originalIdentities.getActiveTools);
	assert.equal(oldRuntime.setActiveTools, originalIdentities.setActiveTools);
	assert.equal(oldRuntime.refreshTools, originalIdentities.refreshTools);
	installation.teardown();
});
