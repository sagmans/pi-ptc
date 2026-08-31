import {
	assert,
	assertCompatible,
	assertFacadeAssociation,
	assertIncompatible,
	createFakeSessionClass,
	createInstaller,
	createTool,
	EXPECTED_REBIND_CAPTURE_COUNT,
	type FakeSessionShape,
	type FakeTool,
	installPiRuntimeCapturePatch,
	type PiRuntimeCapture,
	PTC_TOOL_NAME,
	SAMPLE_TOOL_NAME,
	SUPPORTED_PI_VERSION,
	tagPtcToolDefinition,
	test,
} from "./support/pi-runtime-harness.ts";

test("capture validates registry entry execution fields", async () => {
	const cases: Array<{ name: string; tool: unknown; expected: RegExp }> = [
		{
			name: "parameters",
			tool: { execute: async () => ({}) },
			expected: /parameters/,
		},
		{
			name: "prepareArguments",
			tool: { ...createTool(), prepareArguments: true },
			expected: /prepareArguments/,
		},
		{
			name: "executionMode",
			tool: { ...createTool(), executionMode: "exclusive" },
			expected: /executionMode/,
		},
		{
			name: "execute",
			tool: { parameters: { type: "object" } },
			expected: /execute/,
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
		const session = new (
			Session as unknown as new () => FakeSessionShape & {
				ptcDefinition: object;
				bindExtensions(): Promise<unknown>;
			}
		)();
		session._toolRegistry = new Map([[SAMPLE_TOOL_NAME, testCase.tool as FakeTool]]);
		session.ptcDefinition = tagPtcToolDefinition(
			{ name: PTC_TOOL_NAME },
			createInstaller(captures),
		);

		await session.bindExtensions();

		assertIncompatible(captures[0], testCase.expected);
		installation.teardown();
	}
});

test("same installer keeps independent captures current for two sessions", async () => {
	const { Session } = createFakeSessionClass();
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	const firstSession = new Session();
	const secondSession = new Session();
	firstSession.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
	secondSession.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);

	await firstSession.bindExtensions();
	await secondSession.bindExtensions();

	assert.equal(captures.length, EXPECTED_REBIND_CAPTURE_COUNT);
	assertFacadeAssociation(assertCompatible(captures[0]), firstSession);
	assertFacadeAssociation(assertCompatible(captures[1]), secondSession);
	installation.teardown();
});
