import {
	assert,
	assertCompatible,
	assertStale,
	createFakeSessionClass,
	createInstaller,
	createRunner,
	createTool,
	EMIT_BEFORE_AGENT_START_PROPERTY,
	EMIT_TOOL_CALL_PROPERTY,
	type FakeRunner,
	installPiRuntimeCapturePatch,
	type PiRuntimeCapture,
	type PiRuntimeEventFinalizersInstallation,
	PTC_TOOL_NAME,
	SAMPLE_TOOL_NAME,
	SECOND_TOOL_NAME,
	STALE_CAPTURE_PATTERN,
	SUPPORTED_PI_VERSION,
	tagPtcToolDefinition,
	test,
} from "./support/pi-runtime-harness.ts";

test("controlled event finalizers run after inherited Pi aggregators and restore inheritance", async () => {
	const calls: string[] = [];
	let contextCount = 0;
	const rawToolCallResult = { owner: "tool-owner" };
	const rawBeforeAgentStartResult = {
		messages: [{ customType: "owner-message", content: [] }],
		systemPrompt: "owner prompt",
	};
	const { Session } = createFakeSessionClass();
	const captures: PiRuntimeCapture[] = [];
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	if (!installation.compatible) throw new Error("expected compatible installation");
	const session = new Session();
	const runner = createRunner(undefined, {
		async emitToolCall(...args) {
			calls.push(`tool:${String((args[0] as { toolName?: string }).toolName)}`);
			return rawToolCallResult;
		},
		async emitBeforeAgentStart(...args) {
			calls.push(`before:${String(args[0])}`);
			return rawBeforeAgentStartResult;
		},
	});
	runner.createContext = () => ({ generation: ++contextCount });
	session.extensionRunner = runner;
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, createInstaller(captures));
	const inheritedToolCall = runner.emitToolCall;
	const inheritedBeforeAgentStart = runner.emitBeforeAgentStart;
	assert.equal(Object.hasOwn(runner, EMIT_TOOL_CALL_PROPERTY), false);
	assert.equal(Object.hasOwn(runner, EMIT_BEFORE_AGENT_START_PROPERTY), false);
	await session.bindExtensions();
	const adapter = assertCompatible(captures[0]);
	const eventInstallation = adapter.installRuntimeEventFinalizers({
		async finalizeToolCall(args, result, ctx) {
			calls.push(`tool-final:${String((ctx as { generation: number }).generation)}`);
			assert.equal((args[0] as { toolName: string }).toolName, SAMPLE_TOOL_NAME);
			assert.equal(result, rawToolCallResult);
			return { finalized: result };
		},
		async finalizeBeforeAgentStart(args, result, ctx) {
			calls.push(`before-final:${String((ctx as { generation: number }).generation)}`);
			assert.equal(args[0], "prompt");
			assert.equal(result, rawBeforeAgentStartResult);
			return { ...(result as object), finalized: true };
		},
	});

	assert.throws(
		() =>
			adapter.installRuntimeEventFinalizers({
				finalizeToolCall: async (_args, result) => result,
				finalizeBeforeAgentStart: async (_args, result) => result,
			}),
		/already/i,
	);
	assert.deepEqual(await runner.emitToolCall({ toolName: SAMPLE_TOOL_NAME }), {
		finalized: rawToolCallResult,
	});
	assert.deepEqual(await runner.emitBeforeAgentStart("prompt", undefined, "base", { skills: [] }), {
		...rawBeforeAgentStartResult,
		finalized: true,
	});
	assert.deepEqual(calls, [
		`tool:${SAMPLE_TOOL_NAME}`,
		"tool-final:1",
		"before:prompt",
		"before-final:2",
	]);

	eventInstallation.restore();
	eventInstallation.restore();
	assert.equal(Object.hasOwn(runner, EMIT_TOOL_CALL_PROPERTY), false);
	assert.equal(Object.hasOwn(runner, EMIT_BEFORE_AGENT_START_PROPERTY), false);
	assert.equal(runner.emitToolCall, inheritedToolCall);
	assert.equal(runner.emitBeforeAgentStart, inheritedBeforeAgentStart);
	installation.teardown();
});

test("event finalizer installation rolls back a partial runner patch", async () => {
	const { Session } = createFakeSessionClass();
	const captures: PiRuntimeCapture[] = [];
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	if (!installation.compatible) throw new Error("expected compatible installation");
	const session = new Session();
	const runnerTarget = createRunner();
	const runner = new Proxy(runnerTarget, {
		defineProperty(target, property, descriptor) {
			if (property === EMIT_BEFORE_AGENT_START_PROPERTY) {
				throw new Error("planned event patch failure");
			}
			return Reflect.defineProperty(target, property, descriptor);
		},
	});
	session.extensionRunner = runner;
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, createInstaller(captures));
	await session.bindExtensions();
	const adapter = assertCompatible(captures[0]);

	assert.throws(
		() =>
			adapter.installRuntimeEventFinalizers({
				finalizeToolCall: async (_args, result) => result,
				finalizeBeforeAgentStart: async (_args, result) => result,
			}),
		/event.*patch|could not.*event/i,
	);
	assert.equal(Object.hasOwn(runnerTarget, EMIT_TOOL_CALL_PROPERTY), false);
	assert.equal(Object.hasOwn(runnerTarget, EMIT_BEFORE_AGENT_START_PROPERTY), false);
	installation.teardown();
});

test("event finalizers stale on identity drift and restore only wrappers still owned", async () => {
	let rawToolCalls = 0;
	const { Session } = createFakeSessionClass();
	const captures: PiRuntimeCapture[] = [];
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	if (!installation.compatible) throw new Error("expected compatible installation");
	const session = new Session();
	const runner = createRunner(undefined, {
		async emitToolCall() {
			rawToolCalls += 1;
			return undefined;
		},
	});
	session.extensionRunner = runner;
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, createInstaller(captures));
	await session.bindExtensions();
	const adapter = assertCompatible(captures[0]);
	const eventInstallation = adapter.installRuntimeEventFinalizers({
		finalizeToolCall: async (_args, result) => result,
		finalizeBeforeAgentStart: async (_args, result) => result,
	});
	const ownedToolCall = runner.emitToolCall;
	const foreignBeforeAgentStart = async () => ({ systemPrompt: "foreign" });
	runner.emitBeforeAgentStart = foreignBeforeAgentStart;

	await assert.rejects(
		Reflect.apply(ownedToolCall, runner, [{ toolName: SAMPLE_TOOL_NAME }]),
		STALE_CAPTURE_PATTERN,
	);
	assert.equal(rawToolCalls, 0);
	eventInstallation.restore();
	assert.equal(Object.hasOwn(runner, EMIT_TOOL_CALL_PROPERTY), false);
	assert.equal(runner.emitBeforeAgentStart, foreignBeforeAgentStart);
	installation.teardown();
});

test("event finalizers retain through reload until explicit restore", async () => {
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const replacementRunner = createRunner();
	const replacementRegistry = new Map([[SECOND_TOOL_NAME, createTool()]]);
	let eventInstallation: PiRuntimeEventFinalizersInstallation | undefined;
	let retainedResult: unknown;
	let oldRunner: FakeRunner | undefined;
	const { Session } = createFakeSessionClass({
		async onReload(session) {
			assert.ok(oldRunner);
			retainedResult = await oldRunner.emitToolCall({ toolName: SAMPLE_TOOL_NAME });
			eventInstallation?.restore();
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
	oldRunner = session.extensionRunner;
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
	await session.bindExtensions();
	const oldAdapter = assertCompatible(captures[0]);
	eventInstallation = oldAdapter.installRuntimeEventFinalizers({
		finalizeToolCall: async (_args, result) => ({ retained: result }),
		finalizeBeforeAgentStart: async (_args, result) => result,
	});

	await session.reload();

	assert.deepEqual(retainedResult, { retained: undefined });
	assertStale(oldAdapter);
	assert.equal(Object.hasOwn(oldRunner, EMIT_TOOL_CALL_PROPERTY), false);
	assert.equal(Object.hasOwn(oldRunner, EMIT_BEFORE_AGENT_START_PROPERTY), false);
	assertCompatible(captures[1]);
	installation.teardown();
});
