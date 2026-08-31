import {
	assert,
	assertCompatible,
	assertFacadeAssociation,
	assertIncompatible,
	CHARACTERIZATION_TOOL_CALL_ID,
	createFakeSessionClass,
	createInstaller,
	EMIT_BEFORE_AGENT_START_PROPERTY,
	EMIT_TOOL_CALL_PROPERTY,
	EXPECTED_CAPTURE_COUNT,
	type FakeSessionShape,
	installPiRuntimeCapturePatch,
	ORIGINAL_RESULT,
	type PiRuntimeCapture,
	PTC_TOOL_NAME,
	SAMPLE_TOOL_NAME,
	SECOND_TOOL_NAME,
	SUPPORTED_PI_VERSION,
	tagPtcToolDefinition,
	test,
} from "./support/pi-runtime-harness.ts";

test("tagged ptc definition receives a validated captured-session adapter after binding", async () => {
	const { Session, bindEvents } = createFakeSessionClass();
	const captures: PiRuntimeCapture[] = [];
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	const session = new (
		Session as unknown as new () => FakeSessionShape & {
			ptcDefinition: object;
			bindExtensions(): Promise<unknown>;
		}
	)();
	const definition = { name: PTC_TOOL_NAME };
	session.ptcDefinition = tagPtcToolDefinition(definition, createInstaller(captures));
	const rawRunner = session.extensionRunner;
	const rawRuntime = rawRunner.runtime;
	const rawTool = session._toolRegistry.get(SAMPLE_TOOL_NAME);
	assert.ok(rawTool);
	rawRunner.createContext = function () {
		assert.equal(this, rawRunner);
		return { cwd: "/tmp" };
	};
	rawRunner.emit = async function () {
		assert.equal(this, rawRunner);
	};
	rawRuntime.getActiveTools = function () {
		assert.equal(this, rawRuntime);
		return [SAMPLE_TOOL_NAME];
	};
	rawRuntime.setActiveTools = function () {
		assert.equal(this, rawRuntime);
	};
	rawRuntime.refreshTools = function () {
		assert.equal(this, rawRuntime);
	};
	rawTool.prepareArguments = function (args) {
		assert.equal(this, rawTool);
		return args;
	};
	rawTool.execute = async function () {
		assert.equal(this, rawTool);
		return { owner: SAMPLE_TOOL_NAME };
	};
	const rawAgent = session.agent;
	rawAgent.beforeToolCall = async function () {
		assert.equal(this, rawAgent);
		return undefined;
	};
	rawAgent.afterToolCall = async function () {
		assert.equal(this, rawAgent);
		return undefined;
	};

	const result = await session.bindExtensions();

	assert.equal(result, ORIGINAL_RESULT);
	assert.deepEqual(bindEvents, ["original"]);
	assert.equal(captures.length, EXPECTED_CAPTURE_COUNT);
	const adapter = assertCompatible(captures[0]);
	assert.equal(adapter.version, SUPPORTED_PI_VERSION);
	assertFacadeAssociation(adapter, session);
	assert.equal(adapter.extensionRunner, adapter.extensionRunner);
	assert.equal(adapter.sharedRuntime, adapter.sharedRuntime);
	assert.equal(adapter.toolRegistry, adapter.toolRegistry);
	assert.equal(adapter.beforeToolCall, adapter.beforeToolCall);
	assert.equal(adapter.afterToolCall, adapter.afterToolCall);
	assert.equal(adapter.getToolDefinition(PTC_TOOL_NAME), definition);
	assert.deepEqual(adapter.sharedRuntime.getActiveTools(), [SAMPLE_TOOL_NAME]);
	adapter.sharedRuntime.setActiveTools([SAMPLE_TOOL_NAME]);
	adapter.sharedRuntime.refreshTools();
	assert.deepEqual(adapter.extensionRunner.createContext(), { cwd: "/tmp" });
	await adapter.extensionRunner.emit({ type: "agent_settled" });
	await adapter.beforeToolCall({});
	await adapter.afterToolCall({});
	const facadeTool = adapter.toolRegistry.get(SAMPLE_TOOL_NAME);
	assert.ok(facadeTool);
	assert.equal(facadeTool, adapter.toolRegistry.get(SAMPLE_TOOL_NAME));
	assert.equal(facadeTool.parameters, rawTool.parameters);
	assert.equal(facadeTool.executionMode, rawTool.executionMode);
	assert.deepEqual(facadeTool.prepareArguments?.({ value: SAMPLE_TOOL_NAME }), {
		value: SAMPLE_TOOL_NAME,
	});
	assert.deepEqual(await facadeTool.execute(CHARACTERIZATION_TOOL_CALL_ID, {}), {
		owner: SAMPLE_TOOL_NAME,
	});
	assert.equal(adapter.toolRegistry.size, EXPECTED_CAPTURE_COUNT);
	assert.equal(adapter.toolRegistry.has(SAMPLE_TOOL_NAME), true);
	assert.equal(adapter.toolRegistry.has(SECOND_TOOL_NAME), false);
	const callbackOwner = { name: "callback-owner" };
	const callbackEntries: Array<[string, unknown]> = [];
	adapter.toolRegistry.forEach(function (this: typeof callbackOwner, tool, name, registry) {
		assert.equal(this, callbackOwner);
		assert.equal(registry, adapter.toolRegistry);
		callbackEntries.push([name, tool]);
	}, callbackOwner);
	assert.deepEqual(callbackEntries, [[SAMPLE_TOOL_NAME, facadeTool]]);
	assert.deepEqual([...adapter.toolRegistry.entries()], [[SAMPLE_TOOL_NAME, facadeTool]]);
	assert.deepEqual([...adapter.toolRegistry.keys()], [SAMPLE_TOOL_NAME]);
	assert.deepEqual([...adapter.toolRegistry.values()], [facadeTool]);
	assert.deepEqual([...adapter.toolRegistry], [[SAMPLE_TOOL_NAME, facadeTool]]);
	installation.teardown();
});

test("capture exposes session-scoped ownership evidence for the exact tagged ptc definition", async () => {
	const { Session } = createFakeSessionClass();
	const captures: PiRuntimeCapture[] = [];
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	if (!installation.compatible) throw new Error("expected compatible installation");
	const session = new Session();
	const installer = createInstaller(captures);
	const definition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
	session.ptcDefinition = definition;

	await session.bindExtensions();

	const capture = captures[0];
	assert.ok(capture);
	assert.equal(capture.transportOwnership?.isCurrent(), true);
	session.ptcDefinition = { name: PTC_TOOL_NAME };
	assert.equal(capture.transportOwnership?.isCurrent(), false);
	installation.teardown();
});

test("capture rejects every required private shape mismatch without runtime mutation", async () => {
	const cases: Array<{
		name: string;
		mutate(session: FakeSessionShape): void;
		expected: RegExp;
		throws?: boolean;
	}> = [
		{
			name: "getToolDefinition",
			mutate: (session) => {
				(session as unknown as { getToolDefinition: unknown }).getToolDefinition = undefined;
			},
			expected: /getToolDefinition/,
			throws: true,
		},
		{
			name: "extensionRunner",
			mutate: (session) => {
				(session as unknown as { extensionRunner: unknown }).extensionRunner = undefined;
			},
			expected: /extensionRunner/,
		},
		{
			name: "createContext",
			mutate: (session) => {
				(session.extensionRunner as unknown as { createContext: unknown }).createContext =
					undefined;
			},
			expected: /createContext/,
		},
		{
			name: "emit",
			mutate: (session) => {
				(session.extensionRunner as unknown as { emit: unknown }).emit = undefined;
			},
			expected: /emit/,
		},
		{
			name: "emitToolCall",
			mutate: (session) => {
				(session.extensionRunner as unknown as { emitToolCall: unknown }).emitToolCall = undefined;
			},
			expected: /emitToolCall/,
		},
		{
			name: "emitBeforeAgentStart",
			mutate: (session) => {
				(
					session.extensionRunner as unknown as { emitBeforeAgentStart: unknown }
				).emitBeforeAgentStart = undefined;
			},
			expected: /emitBeforeAgentStart/,
		},
		{
			name: "unpatchable emitToolCall",
			mutate: (session) => {
				Object.defineProperty(session.extensionRunner, EMIT_TOOL_CALL_PROPERTY, {
					value: session.extensionRunner.emitToolCall,
					configurable: false,
					writable: false,
				});
			},
			expected: /emitToolCall.*not patchable/i,
		},
		{
			name: "unpatchable emitBeforeAgentStart",
			mutate: (session) => {
				Object.defineProperty(session.extensionRunner, EMIT_BEFORE_AGENT_START_PROPERTY, {
					value: session.extensionRunner.emitBeforeAgentStart,
					configurable: false,
					writable: false,
				});
			},
			expected: /emitBeforeAgentStart.*not patchable/i,
		},
		{
			name: "runner runtime",
			mutate: (session) => {
				(session.extensionRunner as unknown as { runtime: unknown }).runtime = undefined;
			},
			expected: /runtime/,
		},
		{
			name: "getActiveTools",
			mutate: (session) => {
				(session.extensionRunner.runtime as unknown as { getActiveTools: unknown }).getActiveTools =
					undefined;
			},
			expected: /getActiveTools/,
		},
		{
			name: "setActiveTools",
			mutate: (session) => {
				(session.extensionRunner.runtime as unknown as { setActiveTools: unknown }).setActiveTools =
					undefined;
			},
			expected: /setActiveTools/,
		},
		{
			name: "refreshTools",
			mutate: (session) => {
				(session.extensionRunner.runtime as unknown as { refreshTools: unknown }).refreshTools =
					undefined;
			},
			expected: /refreshTools/,
		},
		{
			name: "tool registry",
			mutate: (session) => {
				(session as unknown as { _toolRegistry: unknown })._toolRegistry = undefined;
			},
			expected: /_toolRegistry/,
		},
		{
			name: "before hook",
			mutate: (session) => {
				session.agent.beforeToolCall = undefined;
			},
			expected: /beforeToolCall/,
		},
		{
			name: "after hook",
			mutate: (session) => {
				session.agent.afterToolCall = undefined;
			},
			expected: /afterToolCall/,
		},
	];

	for (const testCase of cases) {
		const { Session } = createFakeSessionClass();
		let setActiveToolsCalls = 0;
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
		session.extensionRunner.runtime.setActiveTools = () => {
			setActiveToolsCalls += 1;
		};
		session.ptcDefinition = tagPtcToolDefinition(
			{ name: PTC_TOOL_NAME },
			createInstaller(captures),
		);
		const registry = session._toolRegistry;
		const beforeHook = session.agent.beforeToolCall;
		const afterHook = session.agent.afterToolCall;
		testCase.mutate(session);

		if (testCase.throws) {
			await assert.rejects(session.bindExtensions(), testCase.expected);
			assert.deepEqual(captures, [], testCase.name);
		} else {
			await session.bindExtensions();
			assert.equal(captures.length, EXPECTED_CAPTURE_COUNT, testCase.name);
			assertIncompatible(captures[0], testCase.expected);
		}
		assert.equal(setActiveToolsCalls, 0, testCase.name);
		if (testCase.name !== "tool registry") {
			assert.equal(session._toolRegistry, registry, testCase.name);
		}
		if (testCase.name !== "before hook") {
			assert.equal(session.agent.beforeToolCall, beforeHook, testCase.name);
		}
		if (testCase.name !== "after hook") {
			assert.equal(session.agent.afterToolCall, afterHook, testCase.name);
		}
		installation.teardown();
	}
});
