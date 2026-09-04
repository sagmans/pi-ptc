import { strict as assert } from "node:assert";
import test from "node:test";

import {
	installPiRuntimeCapturePatch,
	type PiRuntimeCapture,
	type PiRuntimeTool,
	SUPPORTED_PI_VERSION,
	tagPtcToolDefinition,
} from "../src/pi-runtime.ts";
import { createToolCatalog, type ToolCatalogRefreshFailure } from "../src/tool-catalog.ts";

const PTC_TOOL_NAME = "ptc";
const ALPHA_TOOL_NAME = "alpha";
const BETA_TOOL_NAME = "beta";
const DORMANT_TOOL_NAME = "dormant";
const MISSING_TOOL_NAME = "missing";
const ZETA_TOOL_NAME = "zeta";
const TOOL_CALL_ID = "catalog-call";

type FakeTool = PiRuntimeTool & { owner: string };
type RegistryInput = ReadonlyArray<readonly [string, FakeTool, object]>;
type CatalogHarness = {
	adapter: Extract<PiRuntimeCapture, { compatible: true }>["session"];
	physical(): string[];
	queueRegistry(registry: RegistryInput): void;
	teardownPatch(): void;
	initialize(): Promise<void>;
};

function createTool(owner: string): FakeTool {
	return {
		owner,
		parameters: { type: "object", owner },
		executionMode: "parallel",
		async execute() {
			return { owner };
		},
	};
}

function createHarness(input: { active: string[]; registry: RegistryInput }): CatalogHarness {
	let physical = [...input.active];
	let pendingRegistry: RegistryInput | undefined;
	const captures: PiRuntimeCapture[] = [];
	const installer = {
		capturePiRuntime(capture: PiRuntimeCapture) {
			captures.push(capture);
		},
	};
	const ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);

	class FakeSession {
		agent = {
			beforeToolCall: async () => undefined,
			afterToolCall: async () => undefined,
		};
		definitions = new Map<string, object>();
		_toolRegistry = new Map<string, FakeTool>();
		extensionRunner = {
			createContext: () => ({ cwd: "/tmp" }),
			emit: async () => undefined,
			emitToolCall: async () => undefined,
			emitBeforeAgentStart: async () => undefined,
			runtime: {
				getActiveTools: () => [...physical],
				setActiveTools: (names: string[]) => {
					physical = names.filter((name) => this._toolRegistry.has(name));
				},
				refreshTools: () => {
					const previousRegistryNames = new Set(this._toolRegistry.keys());
					const previousActiveNames = [...physical];
					if (pendingRegistry) {
						this.setRegistry(pendingRegistry);
						pendingRegistry = undefined;
					}
					const nextActiveNames = previousActiveNames.filter((name) =>
						this._toolRegistry.has(name),
					);
					for (const name of this._toolRegistry.keys()) {
						if (!previousRegistryNames.has(name)) nextActiveNames.push(name);
					}
					physical = [...new Set(nextActiveNames)];
				},
			},
		};

		constructor() {
			this.setRegistry(input.registry);
			this.definitions.set(PTC_TOOL_NAME, ptcDefinition);
		}

		setRegistry(registry: RegistryInput): void {
			this._toolRegistry = new Map(registry.map(([name, tool]) => [name, tool]));
			this.definitions = new Map(registry.map(([name, _tool, definition]) => [name, definition]));
			this.definitions.set(PTC_TOOL_NAME, ptcDefinition);
		}

		getToolDefinition(name: string): object | undefined {
			return this.definitions.get(name);
		}

		async bindExtensions(): Promise<void> {}
		async reload(): Promise<void> {}
	}

	const installation = installPiRuntimeCapturePatch({
		agentSession: FakeSession,
		version: SUPPORTED_PI_VERSION,
	});
	if (!installation.compatible) assert.fail(installation.diagnostic);
	const session = new FakeSession();
	return {
		get adapter() {
			const capture = captures[0];
			if (!capture) assert.fail("expected runtime capture");
			if (!capture.compatible) assert.fail(capture.diagnostic);
			return capture.session;
		},
		physical: () => [...physical],
		queueRegistry(registry: RegistryInput) {
			pendingRegistry = registry;
		},
		teardownPatch: installation.teardown,
		async initialize(): Promise<void> {
			await session.bindExtensions();
		},
	};
}

async function initializedHarness(input: {
	active: string[];
	registry: RegistryInput;
}): Promise<CatalogHarness> {
	const harness = createHarness(input);
	await harness.initialize();
	return harness;
}

test("catalog snapshots logical active tools and resolves exact executable definitions", async () => {
	const alpha = createTool("alpha-v1");
	const dormant = createTool("dormant-v1");
	const ptc = createTool("ptc-v1");
	const zeta = createTool("zeta-v1");
	const alphaDefinition = { name: ALPHA_TOOL_NAME, renderer: "alpha" };
	const dormantDefinition = { name: DORMANT_TOOL_NAME, renderer: "dormant" };
	const zetaDefinition = { name: ZETA_TOOL_NAME, renderer: "zeta" };
	const harness = await initializedHarness({
		active: [ZETA_TOOL_NAME, PTC_TOOL_NAME, MISSING_TOOL_NAME, ALPHA_TOOL_NAME],
		registry: [
			[ZETA_TOOL_NAME, zeta, zetaDefinition],
			[DORMANT_TOOL_NAME, dormant, dormantDefinition],
			[PTC_TOOL_NAME, ptc, { name: PTC_TOOL_NAME }],
			[ALPHA_TOOL_NAME, alpha, alphaDefinition],
		],
	});
	const catalog = createToolCatalog({
		session: harness.adapter,
	});

	try {
		assert.deepEqual(catalog.getLogicalActiveTools(), [ZETA_TOOL_NAME, ALPHA_TOOL_NAME]);
		assert.deepEqual(harness.adapter.sharedRuntime.getActiveTools(), [
			ZETA_TOOL_NAME,
			ALPHA_TOOL_NAME,
			PTC_TOOL_NAME,
		]);
		const snapshot = catalog.snapshot();
		assert.deepEqual(
			snapshot.map((entry) => entry.name),
			[ALPHA_TOOL_NAME, ZETA_TOOL_NAME],
		);
		assert.equal(snapshot[0]?.definition, alphaDefinition);
		assert.equal(snapshot[1]?.definition, zetaDefinition);
		assert.deepEqual(await snapshot[0]?.executable.execute(TOOL_CALL_ID, {}), {
			owner: "alpha-v1",
		});
		assert.equal(
			snapshot.some((entry) => entry.name === DORMANT_TOOL_NAME),
			false,
		);
		assert.equal(
			snapshot.some((entry) => entry.name === MISSING_TOOL_NAME),
			false,
		);
		assert.equal(
			snapshot.some((entry) => entry.name === PTC_TOOL_NAME),
			false,
		);

		assert.deepEqual(catalog.applyPhysical(), { missingTransport: false });
		assert.deepEqual(harness.physical(), [PTC_TOOL_NAME]);
	} finally {
		catalog.restore();
		harness.teardownPatch();
	}
});

test("virtual actions preserve hidden names through read-modify-write and refresh", async () => {
	const alphaV1 = createTool("alpha-v1");
	const alphaV2 = createTool("alpha-v2");
	const beta = createTool("beta-v1");
	const dormant = createTool("dormant-v1");
	const ptc = createTool("ptc-v1");
	const zeta = createTool("zeta-v1");
	const alphaV2Definition = { name: ALPHA_TOOL_NAME, renderer: "alpha-v2" };
	const harness = await initializedHarness({
		active: [ZETA_TOOL_NAME, ALPHA_TOOL_NAME, PTC_TOOL_NAME],
		registry: [
			[ZETA_TOOL_NAME, zeta, { name: ZETA_TOOL_NAME }],
			[ALPHA_TOOL_NAME, alphaV1, { name: ALPHA_TOOL_NAME, renderer: "alpha-v1" }],
			[DORMANT_TOOL_NAME, dormant, { name: DORMANT_TOOL_NAME }],
			[PTC_TOOL_NAME, ptc, { name: PTC_TOOL_NAME }],
		],
	});
	const catalog = createToolCatalog({
		session: harness.adapter,
	});
	const runtime = harness.adapter.sharedRuntime;

	try {
		catalog.applyPhysical();
		const extensionView = runtime.getActiveTools();
		runtime.setActiveTools([
			...extensionView.filter((name) => name !== ZETA_TOOL_NAME),
			DORMANT_TOOL_NAME,
			PTC_TOOL_NAME,
			MISSING_TOOL_NAME,
		]);
		assert.deepEqual(catalog.getLogicalActiveTools(), [ALPHA_TOOL_NAME, DORMANT_TOOL_NAME]);
		assert.deepEqual(harness.physical(), [PTC_TOOL_NAME]);

		harness.queueRegistry([
			[ALPHA_TOOL_NAME, alphaV2, alphaV2Definition],
			[DORMANT_TOOL_NAME, dormant, { name: DORMANT_TOOL_NAME }],
			[BETA_TOOL_NAME, beta, { name: BETA_TOOL_NAME }],
			[PTC_TOOL_NAME, ptc, { name: PTC_TOOL_NAME }],
		]);
		runtime.refreshTools();

		assert.deepEqual(catalog.getLogicalActiveTools(), [
			ALPHA_TOOL_NAME,
			DORMANT_TOOL_NAME,
			BETA_TOOL_NAME,
		]);
		assert.deepEqual(runtime.getActiveTools(), [
			ALPHA_TOOL_NAME,
			DORMANT_TOOL_NAME,
			BETA_TOOL_NAME,
			PTC_TOOL_NAME,
		]);
		assert.deepEqual(harness.physical(), [PTC_TOOL_NAME]);
		const snapshot = catalog.snapshot();
		assert.equal(
			snapshot.find((entry) => entry.name === ALPHA_TOOL_NAME)?.definition,
			alphaV2Definition,
		);
		assert.deepEqual(
			await snapshot
				.find((entry) => entry.name === ALPHA_TOOL_NAME)
				?.executable.execute(TOOL_CALL_ID, {}),
			{ owner: "alpha-v2" },
		);

		runtime.refreshTools();
		assert.deepEqual(catalog.getLogicalActiveTools(), [
			ALPHA_TOOL_NAME,
			DORMANT_TOOL_NAME,
			BETA_TOOL_NAME,
		]);
		assert.deepEqual(harness.physical(), [PTC_TOOL_NAME]);
	} finally {
		catalog.restore();
		harness.teardownPatch();
	}
});

test("failed refresh restores native logical state and invalidates the catalog", async () => {
	const alpha = createTool("alpha-v1");
	const ptc = createTool("ptc-v1");
	const invalid = { execute: async () => ({}) } as unknown as FakeTool;
	const harness = await initializedHarness({
		active: [ALPHA_TOOL_NAME, PTC_TOOL_NAME],
		registry: [
			[ALPHA_TOOL_NAME, alpha, { name: ALPHA_TOOL_NAME }],
			[PTC_TOOL_NAME, ptc, { name: PTC_TOOL_NAME }],
		],
	});
	const failures: ToolCatalogRefreshFailure[] = [];
	const catalog = createToolCatalog({
		session: harness.adapter,
		onRefreshFailure(error) {
			failures.push(error);
		},
	});
	const runtime = harness.adapter.sharedRuntime;

	try {
		catalog.applyPhysical();
		assert.deepEqual(harness.physical(), [PTC_TOOL_NAME]);
		harness.queueRegistry([
			[ALPHA_TOOL_NAME, alpha, { name: ALPHA_TOOL_NAME }],
			[BETA_TOOL_NAME, invalid, { name: BETA_TOOL_NAME }],
			[PTC_TOOL_NAME, ptc, { name: PTC_TOOL_NAME }],
		]);
		let refreshError: unknown;
		try {
			runtime.refreshTools();
		} catch (error) {
			refreshError = error;
		}

		assert.ok(refreshError);
		assert.match(String(refreshError), /no longer associated/);
		assert.equal(failures.length, 1);
		assert.equal(failures[0]?.refreshError, refreshError);
		assert.equal(failures[0]?.rollbackFailed, false);
		assert.equal(failures[0]?.rollbackError, undefined);
		assert.deepEqual(failures[0]?.previousLogicalActiveTools, [ALPHA_TOOL_NAME]);
		assert.deepEqual(harness.physical(), [ALPHA_TOOL_NAME]);
		assert.throws(() => catalog.snapshot(), /restored|stale/i);
		assert.throws(() => catalog.applyPhysical(), /restored|stale/i);
	} finally {
		catalog.restore();
		harness.teardownPatch();
	}
});

test("missing transport fails closed and restore returns native logical state and raw actions", async () => {
	const alpha = createTool("alpha-v1");
	const harness = await initializedHarness({
		active: [ALPHA_TOOL_NAME],
		registry: [[ALPHA_TOOL_NAME, alpha, { name: ALPHA_TOOL_NAME }]],
	});
	const rawRuntime = harness.adapter.sharedRuntime;
	const catalog = createToolCatalog({
		session: harness.adapter,
	});

	assert.deepEqual(catalog.applyPhysical(), { missingTransport: true });
	assert.deepEqual(rawRuntime.getActiveTools(), [ALPHA_TOOL_NAME]);
	assert.deepEqual(harness.physical(), [ALPHA_TOOL_NAME]);
	catalog.restore();
	assert.deepEqual(harness.physical(), [ALPHA_TOOL_NAME]);
	assert.throws(() => catalog.snapshot(), /restored|stale/i);
	harness.teardownPatch();
});
