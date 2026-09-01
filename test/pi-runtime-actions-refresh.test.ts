import {
	assert,
	assertCompatible,
	CHARACTERIZATION_TOOL_CALL_ID,
	createFakeSessionClass,
	createInstaller,
	createTool,
	installPiRuntimeCapturePatch,
	type PiRuntimeCapture,
	PTC_TOOL_NAME,
	SAMPLE_TOOL_NAME,
	SECOND_TOOL_NAME,
	STALE_CAPTURE_PATTERN,
	SUPPORTED_PI_VERSION,
	tagPtcToolDefinition,
	test,
} from "./support/pi-runtime-harness.ts";

test("controlled runtime actions keep issued snapshots through compatible refresh and owned restore", async () => {
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const originalTool = createTool({
		execute: async () => ({ owner: "sample-v1" }),
	});
	const replacementDefinition = { name: SECOND_TOOL_NAME };
	const replacementRegistry = new Map([[SECOND_TOOL_NAME, createTool()]]);
	const { Session } = createFakeSessionClass();
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	if (!installation.compatible) throw new Error("expected compatible installation");
	const session = new Session();
	session._toolRegistry = new Map([[SAMPLE_TOOL_NAME, originalTool]]);
	const sampleDefinition = { name: SAMPLE_TOOL_NAME };
	const ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
	session.ptcDefinition = ptcDefinition;
	session.getToolDefinition = (name) => {
		if (name === PTC_TOOL_NAME) return ptcDefinition;
		if (name === SAMPLE_TOOL_NAME) return sampleDefinition;
		if (name === SECOND_TOOL_NAME) return replacementDefinition;
		return undefined;
	};
	let physical = [SAMPLE_TOOL_NAME, PTC_TOOL_NAME];
	const rawRuntime = session.extensionRunner.runtime;
	rawRuntime.getActiveTools = () => [...physical];
	rawRuntime.setActiveTools = (names) => {
		physical = names.filter((name) => session._toolRegistry.has(name));
	};
	rawRuntime.refreshTools = () => {
		session._toolRegistry = replacementRegistry;
		physical = [SECOND_TOOL_NAME];
	};
	const originalIdentities = {
		getActiveTools: rawRuntime.getActiveTools,
		setActiveTools: rawRuntime.setActiveTools,
		refreshTools: rawRuntime.refreshTools,
	};
	await session.bindExtensions();
	const adapter = assertCompatible(captures[0]);
	const calls: string[] = [];
	const runtimeInstallation = adapter.installRuntimeActions({
		getActiveTools: () => {
			calls.push("virtual-get");
			return [SAMPLE_TOOL_NAME, PTC_TOOL_NAME];
		},
		setActiveTools: (names) => {
			calls.push(`virtual-set:${names.join(",")}`);
		},
		refreshTools: () => {
			calls.push("virtual-refresh");
		},
	});

	assert.notEqual(rawRuntime.getActiveTools, originalIdentities.getActiveTools);
	assert.notEqual(rawRuntime.setActiveTools, originalIdentities.setActiveTools);
	assert.notEqual(rawRuntime.refreshTools, originalIdentities.refreshTools);
	assert.deepEqual(adapter.sharedRuntime.getActiveTools(), [SAMPLE_TOOL_NAME, PTC_TOOL_NAME]);
	adapter.sharedRuntime.setActiveTools([SECOND_TOOL_NAME]);
	adapter.sharedRuntime.refreshTools();
	assert.deepEqual(calls, ["virtual-get", `virtual-set:${SECOND_TOOL_NAME}`, "virtual-refresh"]);
	assert.deepEqual(runtimeInstallation.original.getActiveTools(), [
		SAMPLE_TOOL_NAME,
		PTC_TOOL_NAME,
	]);
	const firstSnapshot = runtimeInstallation.original.snapshotTools();
	assert.deepEqual(
		firstSnapshot.map((entry) => entry.name),
		[SAMPLE_TOOL_NAME],
	);
	assert.equal(firstSnapshot[0]?.definition, sampleDefinition);

	runtimeInstallation.original.refreshTools();

	assert.equal(adapter.version, SUPPORTED_PI_VERSION);
	assert.equal(firstSnapshot[0]?.definition, sampleDefinition);
	assert.deepEqual(await firstSnapshot[0]?.executable.execute(CHARACTERIZATION_TOOL_CALL_ID, {}), {
		owner: "sample-v1",
	});
	const secondSnapshot = runtimeInstallation.original.snapshotTools();
	assert.deepEqual(
		secondSnapshot.map((entry) => entry.name),
		[SECOND_TOOL_NAME],
	);
	assert.equal(secondSnapshot[0]?.definition, replacementDefinition);
	assert.deepEqual(runtimeInstallation.original.getActiveTools(), [SECOND_TOOL_NAME]);

	const foreignGet = () => ["foreign"];
	rawRuntime.getActiveTools = foreignGet;
	runtimeInstallation.restore([SECOND_TOOL_NAME]);
	assert.equal(rawRuntime.getActiveTools, foreignGet);
	assert.equal(rawRuntime.setActiveTools, originalIdentities.setActiveTools);
	assert.equal(rawRuntime.refreshTools, originalIdentities.refreshTools);
	assert.deepEqual(physical, [SECOND_TOOL_NAME]);
	assert.throws(() => runtimeInstallation.original.getActiveTools(), STALE_CAPTURE_PATTERN);
	installation.teardown();
});
