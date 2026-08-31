import {
	assert,
	BIND_EXTENSIONS_PROPERTY,
	COORDINATOR_REGISTRY_SYMBOL,
	createFakeSessionClass,
	GLOBAL_REGISTRY_PATTERN,
	installPiRuntimeCapturePatch,
	PATCH_REGISTRY_SYMBOL,
	piRuntimeModule,
	RELOAD_PROPERTY,
	SUPPORTED_PI_VERSION,
	test,
} from "./support/pi-runtime-harness.ts";

test("accessor-backed global registries reject repeated installs without mutation", () => {
	const cases = [
		{ name: "patch registry", accessorSymbol: PATCH_REGISTRY_SYMBOL },
		{ name: "coordinator registry", accessorSymbol: COORDINATOR_REGISTRY_SYMBOL },
	];

	for (const testCase of cases) {
		const { Session, originalDescriptor, originalReloadDescriptor } = createFakeSessionClass();
		const patchRegistry = new WeakMap<object, unknown>();
		const coordinatorRegistry = new WeakMap<object, unknown>();
		let accessorCalls = 0;
		const globalObject = Object.defineProperties(
			{},
			{
				[PATCH_REGISTRY_SYMBOL]: { value: patchRegistry, configurable: true },
				[COORDINATOR_REGISTRY_SYMBOL]: {
					value: coordinatorRegistry,
					configurable: true,
				},
			},
		);
		Object.defineProperty(globalObject, testCase.accessorSymbol, {
			get() {
				accessorCalls += 1;
				return new WeakMap<object, unknown>();
			},
			configurable: true,
		});
		const originalPatchRegistryDescriptor = Object.getOwnPropertyDescriptor(
			globalObject,
			PATCH_REGISTRY_SYMBOL,
		);
		const originalCoordinatorRegistryDescriptor = Object.getOwnPropertyDescriptor(
			globalObject,
			COORDINATOR_REGISTRY_SYMBOL,
		);

		const installations = [
			installPiRuntimeCapturePatch({
				agentSession: Session,
				version: SUPPORTED_PI_VERSION,
				globalObject,
			}),
			installPiRuntimeCapturePatch({
				agentSession: Session,
				version: SUPPORTED_PI_VERSION,
				globalObject,
			}),
		];

		for (const installation of installations) {
			assert.equal(installation.compatible, false, testCase.name);
			if (installation.compatible) throw new Error("expected global registry incompatibility");
			assert.equal(
				installation.diagnostic,
				`${piRuntimeModule.PI_RUNTIME_DIAGNOSTICS.GLOBAL_REGISTRY}: ${testCase.accessorSymbol.description} entry is incompatible`,
				testCase.name,
			);
		}
		assert.equal(accessorCalls, 0, testCase.name);
		assert.equal(patchRegistry.has(Session.prototype), false, testCase.name);
		assert.equal(coordinatorRegistry.has(Session.prototype), false, testCase.name);
		assert.deepEqual(
			Object.getOwnPropertyDescriptor(globalObject, PATCH_REGISTRY_SYMBOL),
			originalPatchRegistryDescriptor,
			testCase.name,
		);
		assert.deepEqual(
			Object.getOwnPropertyDescriptor(globalObject, COORDINATOR_REGISTRY_SYMBOL),
			originalCoordinatorRegistryDescriptor,
			testCase.name,
		);
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

test("locked or incompatible global registry state fails closed before descriptor mutation", () => {
	const cases: Array<{
		name: string;
		globalObject: object;
	}> = [
		{
			name: "patch registry",
			globalObject: Object.defineProperty({}, PATCH_REGISTRY_SYMBOL, {
				value: {},
				configurable: false,
			}),
		},
		{
			name: "proxy patch registry",
			globalObject: Object.defineProperty({}, PATCH_REGISTRY_SYMBOL, {
				value: new Proxy(new WeakMap(), {}),
				configurable: false,
			}),
		},
		{
			name: "coordinator registry",
			globalObject: Object.defineProperties(
				{},
				{
					[PATCH_REGISTRY_SYMBOL]: {
						value: new WeakMap(),
						configurable: false,
					},
					[COORDINATOR_REGISTRY_SYMBOL]: {
						value: {},
						configurable: false,
					},
				},
			),
		},
		{
			name: "non-extensible global",
			globalObject: Object.preventExtensions({}),
		},
		{
			name: "throwing descriptor trap",
			globalObject: new Proxy(
				{},
				{
					getOwnPropertyDescriptor() {
						throw new Error("planned descriptor trap failure");
					},
				},
			),
		},
	];

	for (const testCase of cases) {
		const { Session, originalDescriptor, originalReloadDescriptor } = createFakeSessionClass();
		let installation: ReturnType<typeof installPiRuntimeCapturePatch> | undefined;

		assert.doesNotThrow(() => {
			installation = installPiRuntimeCapturePatch({
				agentSession: Session,
				version: SUPPORTED_PI_VERSION,
				globalObject: testCase.globalObject,
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

test("malformed coordinator registry entries fail closed before descriptor mutation", () => {
	const cases: Array<{ name: string; value: unknown }> = [
		{ name: "non-record coordinator", value: 1 },
		{ name: "missing slot map", value: {} },
		{ name: "plain-object slot map", value: { slotBySession: {} } },
		{
			name: "proxy slot map",
			value: { slotBySession: new Proxy(new WeakMap(), {}) },
		},
		{
			name: "unusable slot map method",
			value: { slotBySession: Object.assign(new WeakMap(), { get: undefined }) },
		},
		{
			name: "accessor slot map",
			value: Object.defineProperty({}, "slotBySession", {
				get: () => new WeakMap<object, unknown>(),
			}),
		},
		{
			name: "inherited slot map",
			value: Object.create({ slotBySession: new WeakMap<object, unknown>() }),
		},
	];

	for (const testCase of cases) {
		const { Session, originalDescriptor, originalReloadDescriptor } = createFakeSessionClass();
		const patchRegistry = new WeakMap<object, unknown>();
		const coordinatorRegistry = new WeakMap<object, unknown>();
		coordinatorRegistry.set(Session.prototype, testCase.value);
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
