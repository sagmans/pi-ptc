import {
	assert,
	BIND_EXTENSIONS_PROPERTY,
	COORDINATOR_REGISTRY_SYMBOL,
	createFakeSessionClass,
	GLOBAL_REGISTRY_PATTERN,
	installPiRuntimeCapturePatch,
	PATCH_REGISTRY_SYMBOL,
	type piRuntimeModule,
	RELOAD_PROPERTY,
	SUPPORTED_PI_VERSION,
	test,
} from "./support/pi-runtime-harness.ts";

test("malformed installed patch states fail closed before descriptor mutation", () => {
	const cases: Array<{
		name: string;
		mutate(state: Record<string, unknown>): unknown;
	}> = [
		{ name: "non-record state", mutate: () => null },
		{
			name: "active flag",
			mutate: (state) => ({ ...state, active: "yes" }),
		},
		{
			name: "installation count",
			mutate: (state) => ({ ...state, installations: 0 }),
		},
		{
			name: "bind patch property",
			mutate: (state) => ({
				...state,
				bindExtensions: {
					...(state.bindExtensions as Record<string, unknown>),
					property: RELOAD_PROPERTY,
				},
			}),
		},
		{
			name: "bind patch descriptor",
			mutate: (state) => ({
				...state,
				bindExtensions: {
					...(state.bindExtensions as Record<string, unknown>),
					originalDescriptor: {},
				},
			}),
		},
		{
			name: "unpatchable bind descriptor",
			mutate: (state) => {
				const bindPatch = state.bindExtensions as Record<string, unknown>;
				return {
					...state,
					bindExtensions: {
						...bindPatch,
						originalDescriptor: {
							...(bindPatch.originalDescriptor as PropertyDescriptor),
							configurable: false,
							writable: false,
						},
					},
				};
			},
		},
		{
			name: "mixed bind patch descriptor",
			mutate: (state) => {
				const bindPatch = state.bindExtensions as Record<string, unknown>;
				return {
					...state,
					bindExtensions: {
						...bindPatch,
						originalDescriptor: {
							...(bindPatch.originalDescriptor as PropertyDescriptor),
							get: undefined,
						},
					},
				};
			},
		},
		{
			name: "identical bind lifecycle functions",
			mutate: (state) => {
				const bindPatch = state.bindExtensions as Record<string, unknown>;
				return {
					...state,
					bindExtensions: {
						...bindPatch,
						patchedFunction: bindPatch.originalFunction,
					},
				};
			},
		},
		{
			name: "reload original function",
			mutate: (state) => ({
				...state,
				reload: {
					...(state.reload as Record<string, unknown>),
					originalFunction: undefined,
				},
			}),
		},
		{
			name: "reload patched function",
			mutate: (state) => ({
				...state,
				reload: {
					...(state.reload as Record<string, unknown>),
					patchedFunction: undefined,
				},
			}),
		},
		{
			name: "coordinator identity",
			mutate: (state) => ({
				...state,
				coordinator: { slotBySession: new WeakMap() },
			}),
		},
	];

	for (const testCase of cases) {
		const { Session, originalDescriptor, originalReloadDescriptor } = createFakeSessionClass();
		const coordinator = { slotBySession: new WeakMap<object, unknown>() };
		const bindPatchedFunction = async () => undefined;
		const reloadPatchedFunction = async () => undefined;
		const state: Record<string, unknown> = {
			active: true,
			installations: 1,
			bindExtensions: {
				property: BIND_EXTENSIONS_PROPERTY,
				originalDescriptor,
				originalFunction: originalDescriptor.value,
				patchedFunction: bindPatchedFunction,
			},
			reload: {
				property: RELOAD_PROPERTY,
				originalDescriptor: originalReloadDescriptor,
				originalFunction: originalReloadDescriptor.value,
				patchedFunction: reloadPatchedFunction,
			},
			coordinator,
		};
		const patchRegistry = new WeakMap<object, unknown>();
		const coordinatorRegistry = new WeakMap<object, unknown>();
		patchRegistry.set(Session.prototype, testCase.mutate(state));
		coordinatorRegistry.set(Session.prototype, coordinator);
		const globalObject = Object.defineProperties(
			{},
			{
				[PATCH_REGISTRY_SYMBOL]: { value: patchRegistry },
				[COORDINATOR_REGISTRY_SYMBOL]: { value: coordinatorRegistry },
			},
		);
		let installation: ReturnType<typeof installPiRuntimeCapturePatch> | undefined;

		assert.doesNotThrow(() => {
			installation = installPiRuntimeCapturePatch({
				agentSession: Session,
				version: SUPPORTED_PI_VERSION,
				globalObject,
			});
		}, testCase.name);

		assert.ok(installation, testCase.name);
		assert.equal(installation.compatible, false, testCase.name);
		if (installation.compatible) throw new Error("expected global registry incompatibility");
		assert.match(installation.diagnostic, GLOBAL_REGISTRY_PATTERN, testCase.name);
		assert.deepEqual(
			Object.getOwnPropertyDescriptor(Session.prototype, BIND_EXTENSIONS_PROPERTY),
			originalDescriptor,
			testCase.name,
		);
		assert.deepEqual(
			Object.getOwnPropertyDescriptor(Session.prototype, RELOAD_PROPERTY),
			originalReloadDescriptor,
			testCase.name,
		);
	}
});

const installedPatchStateValidationCases: Array<{
	name: string;
	mutate(state: Record<string, unknown>): Record<string, unknown>;
}> = [
	{
		name: "inactive state",
		mutate: (state) => ({ ...state, active: false }),
	},
	{
		name: "unsafe installation count",
		mutate: (state) => ({
			...state,
			installations: Number.MAX_SAFE_INTEGER + 1,
		}),
	},
	{
		name: "state accessor",
		mutate: (state) =>
			Object.defineProperty({ ...state }, "active", {
				get: () => true,
				enumerable: true,
			}),
	},
	{
		name: "lifecycle patch accessor",
		mutate: (state) => {
			const bindPatch = state.bindExtensions as Record<string, unknown>;
			return {
				...state,
				bindExtensions: Object.defineProperty({ ...bindPatch }, "patchedFunction", {
					get: () => bindPatch.patchedFunction,
					enumerable: true,
				}),
			};
		},
	},
];

for (const testCase of installedPatchStateValidationCases) {
	test(`installed patch state rejects ${testCase.name} before descriptor mutation`, () => {
		const { Session, originalDescriptor, originalReloadDescriptor } = createFakeSessionClass();
		const coordinator = { slotBySession: new WeakMap<object, unknown>() };
		const bindPatchedFunction = async () => undefined;
		const reloadPatchedFunction = async () => undefined;
		const state: Record<string, unknown> = {
			active: true,
			installations: 1,
			bindExtensions: {
				property: BIND_EXTENSIONS_PROPERTY,
				originalDescriptor,
				originalFunction: originalDescriptor.value,
				patchedFunction: bindPatchedFunction,
			},
			reload: {
				property: RELOAD_PROPERTY,
				originalDescriptor: originalReloadDescriptor,
				originalFunction: originalReloadDescriptor.value,
				patchedFunction: reloadPatchedFunction,
			},
			coordinator,
		};
		Object.defineProperty(Session.prototype, BIND_EXTENSIONS_PROPERTY, {
			...originalDescriptor,
			value: bindPatchedFunction,
		});
		Object.defineProperty(Session.prototype, RELOAD_PROPERTY, {
			...originalReloadDescriptor,
			value: reloadPatchedFunction,
		});
		const patchedBindDescriptor = Object.getOwnPropertyDescriptor(
			Session.prototype,
			BIND_EXTENSIONS_PROPERTY,
		);
		const patchedReloadDescriptor = Object.getOwnPropertyDescriptor(
			Session.prototype,
			RELOAD_PROPERTY,
		);
		const patchRegistry = new WeakMap<object, unknown>();
		const coordinatorRegistry = new WeakMap<object, unknown>();
		patchRegistry.set(Session.prototype, testCase.mutate(state));
		coordinatorRegistry.set(Session.prototype, coordinator);
		const globalObject = Object.defineProperties(
			{},
			{
				[PATCH_REGISTRY_SYMBOL]: { value: patchRegistry },
				[COORDINATOR_REGISTRY_SYMBOL]: { value: coordinatorRegistry },
			},
		);

		const installation = installPiRuntimeCapturePatch({
			agentSession: Session,
			version: SUPPORTED_PI_VERSION,
			globalObject,
		});

		assert.equal(installation.compatible, false, testCase.name);
		if (installation.compatible) throw new Error("expected global registry incompatibility");
		assert.match(installation.diagnostic, GLOBAL_REGISTRY_PATTERN, testCase.name);
		assert.deepEqual(
			Object.getOwnPropertyDescriptor(Session.prototype, BIND_EXTENSIONS_PROPERTY),
			patchedBindDescriptor,
			testCase.name,
		);
		assert.deepEqual(
			Object.getOwnPropertyDescriptor(Session.prototype, RELOAD_PROPERTY),
			patchedReloadDescriptor,
			testCase.name,
		);
	});
}

test("structurally valid global patch state interoperates across module copies", async () => {
	const { Session, originalDescriptor, originalReloadDescriptor } = createFakeSessionClass();
	const globalObject = {};
	const firstInstallation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
		globalObject,
	});
	assert.equal(firstInstallation.compatible, true);
	if (!firstInstallation.compatible) throw new Error("expected compatible installation");
	const patchedBind = Object.getOwnPropertyDescriptor(
		Session.prototype,
		BIND_EXTENSIONS_PROPERTY,
	)?.value;
	const patchedReload = Object.getOwnPropertyDescriptor(Session.prototype, RELOAD_PROPERTY)?.value;
	const copyUrl = new URL("../src/pi-runtime.ts?cross-copy-registry", import.meta.url);
	const runtimeCopy = (await import(copyUrl.href)) as typeof piRuntimeModule;

	const secondInstallation = runtimeCopy.installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
		globalObject,
	});

	assert.equal(secondInstallation.compatible, true);
	if (!secondInstallation.compatible)
		throw new Error("expected compatible cross-copy installation");
	assert.equal(
		Object.getOwnPropertyDescriptor(Session.prototype, BIND_EXTENSIONS_PROPERTY)?.value,
		patchedBind,
	);
	assert.equal(
		Object.getOwnPropertyDescriptor(Session.prototype, RELOAD_PROPERTY)?.value,
		patchedReload,
	);
	firstInstallation.teardown();
	assert.equal(
		Object.getOwnPropertyDescriptor(Session.prototype, BIND_EXTENSIONS_PROPERTY)?.value,
		patchedBind,
	);
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
