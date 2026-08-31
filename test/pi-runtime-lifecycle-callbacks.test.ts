import {
	assert,
	assertCompatible,
	assertFacadeAssociation,
	assertIncompatible,
	assertStale,
	CALLBACK_FAILURE_MESSAGE,
	createFakeSessionClass,
	createInstaller,
	EXPECTED_CAPTURE_COUNT,
	EXPECTED_REBIND_CAPTURE_COUNT,
	type FakeSessionShape,
	installPiRuntimeCapturePatch,
	ORIGINAL_ERROR,
	type PiRuntimeCapture,
	type PiRuntimeInstaller,
	PTC_TOOL_NAME,
	SUPPORTED_PI_VERSION,
	tagPtcToolDefinition,
	test,
} from "./support/pi-runtime-harness.ts";

test("compatible callback failure clears only the published association and preserves error", async () => {
	const rejection = new Error(CALLBACK_FAILURE_MESSAGE);
	const delivered: PiRuntimeCapture[] = [];
	let retainedAdapter: ReturnType<typeof assertCompatible> | undefined;
	let rejectCapture = true;
	const installer: PiRuntimeInstaller = {
		capturePiRuntime(capture) {
			delivered.push(capture);
			if (capture.compatible) retainedAdapter = capture.session;
			if (rejectCapture) throw rejection;
		},
	};
	const { Session } = createFakeSessionClass();
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	const session = new Session();
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);

	await assert.rejects(session.bindExtensions(), (error) => error === rejection);

	assert.ok(retainedAdapter);
	assertStale(retainedAdapter);
	rejectCapture = false;
	await session.bindExtensions();
	assert.equal(delivered.length, EXPECTED_REBIND_CAPTURE_COUNT);
	const recoveredAdapter = assertCompatible(delivered[1]);
	assertFacadeAssociation(recoveredAdapter, session);
	installation.teardown();
});

test("incompatible callback failure leaves no live slot and lifecycle can recover", async () => {
	const rejection = new Error(CALLBACK_FAILURE_MESSAGE);
	const delivered: PiRuntimeCapture[] = [];
	let rejectIncompatible = false;
	const installer: PiRuntimeInstaller = {
		capturePiRuntime(capture) {
			delivered.push(capture);
			if (!capture.compatible && rejectIncompatible) throw rejection;
		},
	};
	const { Session } = createFakeSessionClass();
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	const session = new Session();
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
	await session.bindExtensions();
	const priorAdapter = assertCompatible(delivered[0]);
	const originalEmit = session.extensionRunner.emit;
	(session.extensionRunner as unknown as { emit: unknown }).emit = undefined;
	rejectIncompatible = true;

	await assert.rejects(session.bindExtensions(), (error) => error === rejection);

	assert.equal(delivered.length, EXPECTED_REBIND_CAPTURE_COUNT);
	assertIncompatible(delivered[1], /emit/);
	assertStale(priorAdapter);
	rejectIncompatible = false;
	session.extensionRunner.emit = originalEmit;
	await session.bindExtensions();
	assert.equal(delivered.length, EXPECTED_REBIND_CAPTURE_COUNT + EXPECTED_CAPTURE_COUNT);
	const recoveredAdapter = assertCompatible(delivered[2]);
	assertFacadeAssociation(recoveredAdapter, session);
	installation.teardown();
});

test("failed original binding does not expose a capture", async () => {
	const { Session } = createFakeSessionClass({ throwOnBind: true });
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
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, createInstaller(captures));

	await assert.rejects(session.bindExtensions(), new RegExp(ORIGINAL_ERROR));
	assert.deepEqual(captures, []);
	installation.teardown();
});
