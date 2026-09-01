import {
	assert,
	BIND_EXTENSIONS_PROPERTY,
	createFakeSessionClass,
	ensureSharedPiRuntimeCapturePatch,
	GLOBAL_REGISTRY_PATTERN,
	PATCH_REGISTRY_SYMBOL,
	type piRuntimeModule,
	RELOAD_PROPERTY,
	SHARED_PATCH_LEASE_REGISTRY_SYMBOL,
	SUPPORTED_PI_VERSION,
	test,
} from "./support/pi-runtime-harness.ts";

test("shared patch ensure keeps one process-global lease across module copies", async () => {
	const { Session, originalDescriptor, originalReloadDescriptor } = createFakeSessionClass();
	const globalObject = {};
	const firstEnsure = ensureSharedPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
		globalObject,
	});
	assert.equal(firstEnsure.compatible, true);
	const patchedBind = Object.getOwnPropertyDescriptor(
		Session.prototype,
		BIND_EXTENSIONS_PROPERTY,
	)?.value;
	const patchedReload = Object.getOwnPropertyDescriptor(Session.prototype, RELOAD_PROPERTY)?.value;
	const patchRegistry = Object.getOwnPropertyDescriptor(globalObject, PATCH_REGISTRY_SYMBOL)
		?.value as WeakMap<object, { installations: number }>;
	assert.equal(patchRegistry.get(Session.prototype)?.installations, 1);
	const copyUrl = new URL("../src/pi-runtime.ts?cross-copy-shared-lease", import.meta.url);
	const runtimeCopy = (await import(copyUrl.href)) as typeof piRuntimeModule;

	const secondEnsure = runtimeCopy.ensureSharedPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
		globalObject,
	});

	assert.equal(secondEnsure.compatible, true);
	assert.equal(patchRegistry.get(Session.prototype)?.installations, 1);
	assert.equal(
		Object.getOwnPropertyDescriptor(Session.prototype, BIND_EXTENSIONS_PROPERTY)?.value,
		patchedBind,
	);
	assert.equal(
		Object.getOwnPropertyDescriptor(Session.prototype, RELOAD_PROPERTY)?.value,
		patchedReload,
	);
	const sharedRegistry = Object.getOwnPropertyDescriptor(
		globalObject,
		SHARED_PATCH_LEASE_REGISTRY_SYMBOL,
	)?.value as WeakMap<object, unknown>;
	assert.equal(sharedRegistry.has(Session.prototype), true);
	assert.notDeepEqual(
		Object.getOwnPropertyDescriptor(Session.prototype, BIND_EXTENSIONS_PROPERTY),
		originalDescriptor,
	);
	assert.notDeepEqual(
		Object.getOwnPropertyDescriptor(Session.prototype, RELOAD_PROPERTY),
		originalReloadDescriptor,
	);
});

test("shared patch ensure rejects malformed stored lease without incrementing patch ownership", () => {
	const { Session } = createFakeSessionClass();
	const globalObject = {};
	const firstEnsure = ensureSharedPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
		globalObject,
	});
	assert.equal(firstEnsure.compatible, true);
	const patchRegistry = Object.getOwnPropertyDescriptor(globalObject, PATCH_REGISTRY_SYMBOL)
		?.value as WeakMap<object, { installations: number }>;
	const sharedRegistry = Object.getOwnPropertyDescriptor(
		globalObject,
		SHARED_PATCH_LEASE_REGISTRY_SYMBOL,
	)?.value as WeakMap<object, unknown>;
	sharedRegistry.set(Session.prototype, Object.create({ installation: {} }));

	const repeatedEnsure = ensureSharedPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
		globalObject,
	});

	assert.equal(repeatedEnsure.compatible, false);
	if (repeatedEnsure.compatible) throw new Error("expected malformed shared lease rejection");
	assert.match(repeatedEnsure.diagnostic, GLOBAL_REGISTRY_PATTERN);
	assert.equal(patchRegistry.get(Session.prototype)?.installations, 1);
});

test("shared patch ensure rejects lifecycle ownership drift without acquiring another lease", () => {
	const { Session, originalReloadDescriptor } = createFakeSessionClass();
	const globalObject = {};
	const firstEnsure = ensureSharedPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
		globalObject,
	});
	assert.equal(firstEnsure.compatible, true);
	const patchRegistry = Object.getOwnPropertyDescriptor(globalObject, PATCH_REGISTRY_SYMBOL)
		?.value as WeakMap<object, { installations: number }>;
	const foreignReload = async () => undefined;
	Object.defineProperty(Session.prototype, RELOAD_PROPERTY, {
		...originalReloadDescriptor,
		value: foreignReload,
	});

	const repeatedEnsure = ensureSharedPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
		globalObject,
	});

	assert.equal(repeatedEnsure.compatible, false);
	if (repeatedEnsure.compatible) throw new Error("expected shared patch conflict");
	assert.match(repeatedEnsure.diagnostic, /changed/);
	assert.equal(patchRegistry.get(Session.prototype)?.installations, 1);
	assert.equal(
		Object.getOwnPropertyDescriptor(Session.prototype, RELOAD_PROPERTY)?.value,
		foreignReload,
	);
});
