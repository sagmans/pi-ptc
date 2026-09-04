import {
	assert,
	assertCompatible,
	assertFacadeAssociation,
	assertStale,
	BIND_EXTENSIONS_PROPERTY,
	createDeferred,
	createFakeSessionClass,
	createInstaller,
	createTool,
	EXPECTED_CAPTURE_COUNT,
	EXPECTED_ORIGINAL_CALL_COUNT,
	EXPECTED_REBIND_CAPTURE_COUNT,
	type FakeSessionShape,
	installPiRuntimeCapturePatch,
	ORIGINAL_ERROR,
	ORIGINAL_RESULT,
	type PiRuntimeCapture,
	PTC_TOOL_NAME,
	piRuntimeModule,
	RELOAD_PROPERTY,
	RELOAD_RESULT,
	SAMPLE_TOOL_NAME,
	SECOND_TOOL_NAME,
	SUPPORTED_PI_VERSION,
	tagPtcToolDefinition,
	test,
	UNSUPPORTED_PI_VERSION,
} from "./support/pi-runtime-harness.ts";

test("patch validates reload before mutating bindExtensions", () => {
	class MissingReload {
		async bindExtensions(): Promise<void> {}
	}
	const originalBindDescriptor = Object.getOwnPropertyDescriptor(
		MissingReload.prototype,
		BIND_EXTENSIONS_PROPERTY,
	);
	assert.ok(originalBindDescriptor);

	const installation = installPiRuntimeCapturePatch({
		agentSession: MissingReload,
		version: SUPPORTED_PI_VERSION,
	});

	assert.equal(installation.compatible, false);
	if (installation.compatible) throw new Error("expected incompatible installation");
	assert.match(installation.diagnostic, /reload/);
	assert.deepEqual(
		Object.getOwnPropertyDescriptor(MissingReload.prototype, BIND_EXTENSIONS_PROPERTY),
		originalBindDescriptor,
	);
});

test("version diagnostics accept each verified Pi version and reject mismatched assertions", () => {
	const getVersionDiagnostic = (
		piRuntimeModule as typeof piRuntimeModule & {
			getPiRuntimeVersionDiagnostic(
				importedVersion: string,
				suppliedVersion?: string,
			): string | undefined;
		}
	).getPiRuntimeVersionDiagnostic;
	assert.equal(typeof getVersionDiagnostic, "function");
	if (typeof getVersionDiagnostic !== "function") return;

	for (const version of ["0.84.3", "0.84.4", "0.85.0"]) {
		assert.equal(getVersionDiagnostic(version, version), undefined, version);
	}
	const result = getVersionDiagnostic(UNSUPPORTED_PI_VERSION, SUPPORTED_PI_VERSION);
	assert.match(result ?? "", /0\.84\.2/);
	assert.match(result ?? "", /0\.84\.3/);
	assert.match(result ?? "", /0\.84\.4/);
	assert.match(result ?? "", /0\.85\.0/);
});

test("unsupported version reports incompatibility and leaves prototype untouched", () => {
	const { Session, originalDescriptor } = createFakeSessionClass();
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: UNSUPPORTED_PI_VERSION,
	});

	assert.equal(installation.compatible, false);
	if (installation.compatible) throw new Error("expected unsupported version");
	assert.match(installation.diagnostic, /0\.84\.2/);
	assert.equal(installation.diagnostic.includes(SUPPORTED_PI_VERSION), true);
	assert.deepEqual(
		Object.getOwnPropertyDescriptor(Session.prototype, BIND_EXTENSIONS_PROPERTY),
		originalDescriptor,
	);
});

test("repeated installation patches lifecycle once, isolates sessions, and restores descriptors", async () => {
	const {
		Session,
		originalDescriptor,
		originalFunction,
		originalReloadDescriptor,
		originalReloadFunction,
		bindEvents,
	} = createFakeSessionClass();
	const firstCaptures: PiRuntimeCapture[] = [];
	const secondCaptures: PiRuntimeCapture[] = [];
	const firstInstallation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	const patchedFunction = Object.getOwnPropertyDescriptor(
		Session.prototype,
		BIND_EXTENSIONS_PROPERTY,
	)?.value;
	const patchedReloadFunction = Object.getOwnPropertyDescriptor(
		Session.prototype,
		RELOAD_PROPERTY,
	)?.value;
	const secondInstallation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(firstInstallation.compatible, true);
	assert.equal(secondInstallation.compatible, true);
	if (!firstInstallation.compatible || !secondInstallation.compatible) {
		throw new Error("expected compatible installations");
	}
	assert.notEqual(patchedFunction, originalFunction);
	assert.notEqual(patchedReloadFunction, originalReloadFunction);
	assert.equal(
		Object.getOwnPropertyDescriptor(Session.prototype, BIND_EXTENSIONS_PROPERTY)?.value,
		patchedFunction,
	);
	assert.equal(
		Object.getOwnPropertyDescriptor(Session.prototype, RELOAD_PROPERTY)?.value,
		patchedReloadFunction,
	);
	const FirstSession = Session as unknown as new () => FakeSessionShape & {
		ptcDefinition: object;
		bindExtensions(): Promise<unknown>;
	};
	const firstSession = new FirstSession();
	const secondSession = new FirstSession();
	firstSession.ptcDefinition = tagPtcToolDefinition(
		{ name: PTC_TOOL_NAME },
		createInstaller(firstCaptures),
	);
	secondSession.ptcDefinition = tagPtcToolDefinition(
		{ name: PTC_TOOL_NAME },
		createInstaller(secondCaptures),
	);

	await firstSession.bindExtensions();
	await secondSession.bindExtensions();
	firstSession._toolRegistry = new Map([[SECOND_TOOL_NAME, createTool()]]);
	await firstSession.bindExtensions();

	assert.equal(firstCaptures.length, EXPECTED_REBIND_CAPTURE_COUNT);
	assert.equal(secondCaptures.length, EXPECTED_CAPTURE_COUNT);
	assert.equal(bindEvents.length, EXPECTED_ORIGINAL_CALL_COUNT + EXPECTED_CAPTURE_COUNT);
	assertStale(assertCompatible(firstCaptures[0]));
	assertFacadeAssociation(assertCompatible(firstCaptures[1]), firstSession);
	assert.equal(
		assertCompatible(firstCaptures[1]).getToolDefinition(PTC_TOOL_NAME),
		firstSession.ptcDefinition,
	);
	assertFacadeAssociation(assertCompatible(secondCaptures[0]), secondSession);

	firstInstallation.teardown();
	assert.equal(
		Object.getOwnPropertyDescriptor(Session.prototype, BIND_EXTENSIONS_PROPERTY)?.value,
		patchedFunction,
	);
	assert.equal(
		Object.getOwnPropertyDescriptor(Session.prototype, RELOAD_PROPERTY)?.value,
		patchedReloadFunction,
	);
	secondInstallation.teardown();
	secondInstallation.teardown();
	assert.deepEqual(
		Object.getOwnPropertyDescriptor(Session.prototype, BIND_EXTENSIONS_PROPERTY),
		originalDescriptor,
	);
	assert.deepEqual(
		Object.getOwnPropertyDescriptor(Session.prototype, RELOAD_PROPERTY),
		originalReloadDescriptor,
	);
});

test("reload wrapper conflict is detected and teardown restores only owned wrappers", () => {
	const { Session, originalDescriptor, originalReloadDescriptor } = createFakeSessionClass();
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	if (!installation.compatible) throw new Error("expected compatible installation");
	const foreignReload = async () => undefined;
	Object.defineProperty(Session.prototype, RELOAD_PROPERTY, {
		...originalReloadDescriptor,
		value: foreignReload,
	});

	const repeatedInstallation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});

	assert.equal(repeatedInstallation.compatible, false);
	if (repeatedInstallation.compatible) throw new Error("expected patch conflict");
	assert.match(repeatedInstallation.diagnostic, /changed/);
	installation.teardown();
	assert.deepEqual(
		Object.getOwnPropertyDescriptor(Session.prototype, BIND_EXTENSIONS_PROPERTY),
		originalDescriptor,
	);
	assert.equal(
		Object.getOwnPropertyDescriptor(Session.prototype, RELOAD_PROPERTY)?.value,
		foreignReload,
	);
});

test("teardown during deferred bind restores descriptors without a late capture", async () => {
	const gate = createDeferred();
	const { Session, originalDescriptor, originalReloadDescriptor } = createFakeSessionClass({
		onBind: () => gate.promise,
	});
	const captures: PiRuntimeCapture[] = [];
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	if (!installation.compatible) throw new Error("expected compatible installation");
	const session = new Session();
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, createInstaller(captures));

	const pendingBind = session.bindExtensions();
	installation.teardown();
	gate.resolve();
	assert.equal(await pendingBind, ORIGINAL_RESULT);

	assert.deepEqual(captures, []);
	assert.deepEqual(
		Object.getOwnPropertyDescriptor(Session.prototype, BIND_EXTENSIONS_PROPERTY),
		originalDescriptor,
	);
	assert.deepEqual(
		Object.getOwnPropertyDescriptor(Session.prototype, RELOAD_PROPERTY),
		originalReloadDescriptor,
	);
});

test("teardown during deferred reload stales retained generation without a late capture", async () => {
	const gate = createDeferred();
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const { Session, originalDescriptor, originalReloadDescriptor } = createFakeSessionClass({
		onReload: () => gate.promise,
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
	const firstAdapter = assertCompatible(captures[0]);

	const pendingReload = session.reload();
	try {
		assert.deepEqual(firstAdapter.sharedRuntime.getActiveTools(), [SAMPLE_TOOL_NAME]);
	} finally {
		installation.teardown();
		assertStale(firstAdapter);
		gate.resolve();
		assert.equal(await pendingReload, RELOAD_RESULT);
	}

	assert.equal(captures.length, EXPECTED_CAPTURE_COUNT);
	assertStale(firstAdapter);
	assert.deepEqual(
		Object.getOwnPropertyDescriptor(Session.prototype, BIND_EXTENSIONS_PROPERTY),
		originalDescriptor,
	);
	assert.deepEqual(
		Object.getOwnPropertyDescriptor(Session.prototype, RELOAD_PROPERTY),
		originalReloadDescriptor,
	);
});

test("failed rebinding preserves rejection and leaves the prior generation stale", async () => {
	const rejection = new Error(ORIGINAL_ERROR);
	let bindCount = 0;
	const { Session } = createFakeSessionClass({
		onBind() {
			bindCount += 1;
			if (bindCount === EXPECTED_ORIGINAL_CALL_COUNT) throw rejection;
		},
	});
	const captures: PiRuntimeCapture[] = [];
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	const session = new Session();
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, createInstaller(captures));
	await session.bindExtensions();
	const firstAdapter = assertCompatible(captures[0]);

	await assert.rejects(session.bindExtensions(), (error) => error === rejection);

	assert.equal(captures.length, EXPECTED_CAPTURE_COUNT);
	assertStale(firstAdapter);
	installation.teardown();
});

test("failed reload preserves rejection and leaves the prior generation stale", async () => {
	const rejection = new Error(ORIGINAL_ERROR);
	let firstAdapter: ReturnType<typeof assertCompatible> | undefined;
	const { Session } = createFakeSessionClass({
		onReload() {
			assert.ok(firstAdapter);
			assert.deepEqual(firstAdapter.sharedRuntime.getActiveTools(), [SAMPLE_TOOL_NAME]);
			throw rejection;
		},
	});
	const captures: PiRuntimeCapture[] = [];
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	const session = new Session();
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, createInstaller(captures));
	await session.bindExtensions();
	firstAdapter = assertCompatible(captures[0]);

	await assert.rejects(session.reload(), (error) => error === rejection);

	assert.equal(captures.length, EXPECTED_CAPTURE_COUNT);
	assertStale(firstAdapter);
	installation.teardown();
});
