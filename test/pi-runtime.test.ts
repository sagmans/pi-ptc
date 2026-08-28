import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import * as piRuntimeModule from "../src/pi-runtime.ts";
import {
	installPiRuntimeCapturePatch,
	type PiRuntimeCapture,
	type PiRuntimeInstaller,
	SUPPORTED_PI_VERSION,
	tagPtcToolDefinition,
} from "../src/pi-runtime.ts";

const BIND_EXTENSIONS_PROPERTY = "bindExtensions";
const RELOAD_PROPERTY = "reload";
const PTC_TOOL_NAME = "ptc";
const SAMPLE_TOOL_NAME = "sample";
const SECOND_TOOL_NAME = "second";
const UNSUPPORTED_PI_VERSION = "0.84.2";
const ORIGINAL_RESULT = "original-result";
const RELOAD_RESULT = "reload-result";
const ORIGINAL_ERROR = "planned bind failure";
const EXPECTED_CAPTURE_COUNT = 1;
const EXPECTED_REBIND_CAPTURE_COUNT = 2;
const EXPECTED_ORIGINAL_CALL_COUNT = 2;
const STALE_CAPTURE_PATTERN = /no longer associated/;
const GLOBAL_REGISTRY_PATTERN = /global registry/i;
const PATCH_REGISTRY_SYMBOL = Symbol.for("pi-ptc.pi-runtime.patch-registry.v1");
const COORDINATOR_REGISTRY_SYMBOL = Symbol.for(
	"pi-ptc.pi-runtime.lifecycle-coordinator-registry.v1",
);
const CHARACTERIZATION_DIRECTORY_PREFIX = "pi-ptc-runtime-characterization-";
const CHARACTERIZATION_TOOL_RESULT = "characterized";
const CHARACTERIZATION_TOOL_CALL_ID = "characterization-call";
const CALLBACK_FAILURE_MESSAGE = "planned capture callback failure";
const PACKAGE_JSON_PATH = new URL("../package.json", import.meta.url);
const PACKAGE_LOCK_PATH = new URL("../package-lock.json", import.meta.url);

type FakeTool = {
	parameters: object;
	prepareArguments?: (args: unknown) => unknown;
	executionMode?: "parallel" | "sequential";
	execute: () => Promise<object>;
};

type FakeRunner = {
	createContext: () => object;
	emit: () => Promise<void>;
	runtime: {
		getActiveTools: () => string[];
		setActiveTools: (names: string[]) => void;
		refreshTools: () => void;
	};
};

type FakeSessionShape = {
	agent: {
		beforeToolCall?: (...args: unknown[]) => Promise<unknown>;
		afterToolCall?: (...args: unknown[]) => Promise<unknown>;
	};
	extensionRunner: FakeRunner;
	_toolRegistry: Map<string, FakeTool>;
	ptcDefinition: object | undefined;
	getToolDefinition(name: string): object | undefined;
	bindExtensions(...args: unknown[]): Promise<unknown>;
	reload(...args: unknown[]): Promise<unknown>;
};

type FakeSessionConstructor = {
	new (): FakeSessionShape;
	prototype: FakeSessionShape;
};

type FakeSessionOptions = {
	throwOnBind?: boolean;
	onBind?: (session: FakeSessionShape) => void | Promise<void>;
	onReload?: (session: FakeSessionShape) => void | Promise<void>;
};

function createTool(overrides: Partial<FakeTool> = {}): FakeTool {
	return {
		parameters: { type: "object" },
		prepareArguments: (args) => args,
		executionMode: "parallel",
		execute: async () => ({}),
		...overrides,
	};
}

function createRunner(onSetActiveTools?: () => void): FakeRunner {
	return {
		createContext: () => ({ cwd: "/tmp" }),
		emit: async () => undefined,
		runtime: {
			getActiveTools: () => [SAMPLE_TOOL_NAME],
			setActiveTools: () => onSetActiveTools?.(),
			refreshTools: () => undefined,
		},
	};
}

function createInstaller(captures: PiRuntimeCapture[]): PiRuntimeInstaller {
	return {
		capturePiRuntime(capture) {
			captures.push(capture);
		},
	};
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function createFakeSessionClass(options: FakeSessionOptions = {}): {
	Session: FakeSessionConstructor;
	originalDescriptor: PropertyDescriptor;
	originalFunction: (...args: unknown[]) => Promise<unknown>;
	originalReloadDescriptor: PropertyDescriptor;
	originalReloadFunction: (...args: unknown[]) => Promise<unknown>;
	bindEvents: string[];
	reloadEvents: string[];
} {
	const bindEvents: string[] = [];
	const reloadEvents: string[] = [];
	class FakeSession implements FakeSessionShape {
		agent = {
			beforeToolCall: async () => undefined,
			afterToolCall: async () => undefined,
		};
		extensionRunner = createRunner();
		_toolRegistry = new Map([[SAMPLE_TOOL_NAME, createTool()]]);
		ptcDefinition: object | undefined;

		getToolDefinition(name: string): object | undefined {
			return name === PTC_TOOL_NAME ? this.ptcDefinition : undefined;
		}

		async bindExtensions(): Promise<string> {
			bindEvents.push("original");
			if (options.throwOnBind) throw new Error(ORIGINAL_ERROR);
			await options.onBind?.(this);
			return ORIGINAL_RESULT;
		}

		async reload(): Promise<string> {
			reloadEvents.push("original");
			await options.onReload?.(this);
			return RELOAD_RESULT;
		}
	}
	const originalDescriptor = Object.getOwnPropertyDescriptor(
		FakeSession.prototype,
		BIND_EXTENSIONS_PROPERTY,
	);
	const originalReloadDescriptor = Object.getOwnPropertyDescriptor(
		FakeSession.prototype,
		RELOAD_PROPERTY,
	);
	assert.ok(originalDescriptor);
	assert.ok(originalReloadDescriptor);
	assert.equal(typeof originalDescriptor.value, "function");
	assert.equal(typeof originalReloadDescriptor.value, "function");
	return {
		Session: FakeSession as unknown as FakeSessionConstructor,
		originalDescriptor,
		originalFunction: originalDescriptor.value as (...args: unknown[]) => Promise<unknown>,
		originalReloadDescriptor,
		originalReloadFunction: originalReloadDescriptor.value as (
			...args: unknown[]
		) => Promise<unknown>,
		bindEvents,
		reloadEvents,
	};
}

function assertCompatible(capture: PiRuntimeCapture | undefined) {
	assert.ok(capture);
	assert.equal(capture.compatible, true);
	return capture.session;
}

function assertIncompatible(capture: PiRuntimeCapture | undefined, expected: RegExp): void {
	assert.ok(capture);
	assert.equal(capture.compatible, false);
	if (capture.compatible) throw new Error("expected incompatible capture");
	assert.match(capture.diagnostic, expected);
}

function assertFacadeAssociation(
	adapter: ReturnType<typeof assertCompatible>,
	session: FakeSessionShape,
): void {
	assert.notEqual(adapter.extensionRunner, session.extensionRunner);
	assert.notEqual(adapter.sharedRuntime, session.extensionRunner.runtime);
	assert.notEqual(adapter.toolRegistry, session._toolRegistry);
	assert.notEqual(adapter.beforeToolCall, session.agent.beforeToolCall);
	assert.notEqual(adapter.afterToolCall, session.agent.afterToolCall);
	assert.deepEqual([...adapter.toolRegistry.keys()], [...session._toolRegistry.keys()]);
	for (const [name, tool] of adapter.toolRegistry) {
		assert.notEqual(tool, session._toolRegistry.get(name));
	}
}

function assertRegistryNames(
	adapter: ReturnType<typeof assertCompatible>,
	expected: ReadonlyMap<string, unknown>,
): void {
	assert.deepEqual([...adapter.toolRegistry.keys()], [...expected.keys()]);
}

function assertStale(adapter: ReturnType<typeof assertCompatible>): void {
	const accesses = [
		() => adapter.version,
		() => adapter.extensionRunner,
		() => adapter.sharedRuntime,
		() => adapter.toolRegistry,
		() => adapter.beforeToolCall,
		() => adapter.afterToolCall,
		() => adapter.getToolDefinition(PTC_TOOL_NAME),
	];
	for (const access of accesses) {
		assert.throws(access, STALE_CAPTURE_PATTERN);
	}
}

test("installed Pi exports exact patchable bind and reload runtime methods", () => {
	assert.equal(VERSION, SUPPORTED_PI_VERSION);
	for (const property of [BIND_EXTENSIONS_PROPERTY, RELOAD_PROPERTY]) {
		const descriptor = Object.getOwnPropertyDescriptor(AgentSession.prototype, property);
		assert.ok(descriptor, property);
		assert.equal(typeof descriptor.value, "function", property);
		assert.equal(descriptor.configurable === true || descriptor.writable === true, true, property);
	}
});

test("real Pi 0.84.3 binds a tagged inline ptc definition to the capture seam", async () => {
	const directory = mkdtempSync(join(tmpdir(), CHARACTERIZATION_DIRECTORY_PREFIX));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const captures: PiRuntimeCapture[] = [];
	let emittedEvents = 0;
	let beforeHookCalls = 0;
	let afterHookCalls = 0;
	let toolExecutions = 0;
	const installer = createInstaller(captures);
	const definition = tagPtcToolDefinition(
		defineTool({
			name: PTC_TOOL_NAME,
			label: "PTC characterization",
			description: "Characterize the tagged Pi runtime contract",
			parameters: Type.Object({}),
			prepareArguments: () => ({}),
			executionMode: "parallel",
			execute: async () => {
				toolExecutions += 1;
				return {
					content: [{ type: "text", text: CHARACTERIZATION_TOOL_RESULT }],
					details: undefined,
				};
			},
		}),
		installer,
	);
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [
			{
				name: "ptc-characterization",
				factory(pi) {
					pi.registerTool(definition);
					pi.on("agent_settled", () => {
						emittedEvents += 1;
					});
					pi.on("tool_call", () => {
						beforeHookCalls += 1;
					});
					pi.on("tool_result", () => {
						afterHookCalls += 1;
					});
				},
			},
		],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "",
	});
	const installation = installPiRuntimeCapturePatch();
	assert.equal(installation.compatible, true);
	if (!installation.compatible) throw new Error("expected compatible installation");

	try {
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
			tools: [PTC_TOOL_NAME],
		});

		await session.bindExtensions({ mode: "print" });

		assert.equal(captures.length, EXPECTED_CAPTURE_COUNT);
		const adapter = assertCompatible(captures[0]);
		assert.equal(adapter.getToolDefinition(PTC_TOOL_NAME), definition);
		const context = adapter.extensionRunner.createContext() as { cwd: string };
		assert.equal(context.cwd, cwd);
		await adapter.extensionRunner.emit({ type: "agent_settled" });
		assert.equal(emittedEvents, EXPECTED_CAPTURE_COUNT);
		const activeTools = adapter.sharedRuntime.getActiveTools();
		assert.deepEqual(activeTools, [PTC_TOOL_NAME]);
		adapter.sharedRuntime.setActiveTools(activeTools);
		const tool = adapter.toolRegistry.get(PTC_TOOL_NAME);
		assert.ok(tool);
		assert.equal(adapter.toolRegistry.size, EXPECTED_CAPTURE_COUNT);
		assert.equal(tool.parameters, definition.parameters);
		assert.equal(tool.executionMode, "parallel");
		assert.deepEqual(tool.prepareArguments?.({}), {});
		const toolResult = (await tool.execute(CHARACTERIZATION_TOOL_CALL_ID, {})) as {
			content: Array<{ type: string; text: string }>;
		};
		assert.equal(toolResult.content[0]?.text, CHARACTERIZATION_TOOL_RESULT);
		assert.equal(toolExecutions, EXPECTED_CAPTURE_COUNT);
		await adapter.beforeToolCall({
			toolCall: { id: CHARACTERIZATION_TOOL_CALL_ID, name: PTC_TOOL_NAME },
			args: {},
		});
		await adapter.afterToolCall({
			toolCall: { id: CHARACTERIZATION_TOOL_CALL_ID, name: PTC_TOOL_NAME },
			args: {},
			result: { content: [], details: undefined },
			isError: false,
		});
		assert.equal(beforeHookCalls, EXPECTED_CAPTURE_COUNT);
		assert.equal(afterHookCalls, EXPECTED_CAPTURE_COUNT);
		adapter.sharedRuntime.refreshTools();
		assertStale(adapter);
	} finally {
		installation.teardown();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("package metadata pins the Pi peer to the supported version", () => {
	const manifest = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
		peerDependencies: Record<string, string>;
	};
	const lock = JSON.parse(readFileSync(PACKAGE_LOCK_PATH, "utf8")) as {
		packages: Record<string, { peerDependencies?: Record<string, string> }>;
	};
	assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], SUPPORTED_PI_VERSION);
	assert.equal(
		lock.packages[""]?.peerDependencies?.["@earendil-works/pi-coding-agent"],
		SUPPORTED_PI_VERSION,
	);
});

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

test("reload replaces capture and makes the prior generation stale", async () => {
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const replacementRunner = createRunner();
	const replacementRegistry = new Map([[SECOND_TOOL_NAME, createTool()]]);
	const replacementDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
	const { Session, reloadEvents } = createFakeSessionClass({
		onReload(session) {
			session.extensionRunner = replacementRunner;
			session._toolRegistry = replacementRegistry;
			session.ptcDefinition = replacementDefinition;
		},
	});
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	const session = new Session();
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
	await session.bindExtensions();
	const firstAdapter = assertCompatible(captures[0]);

	const result = await session.reload();

	assert.equal(result, RELOAD_RESULT);
	assert.deepEqual(reloadEvents, ["original"]);
	assert.equal(captures.length, EXPECTED_REBIND_CAPTURE_COUNT);
	assertStale(firstAdapter);
	const replacementAdapter = assertCompatible(captures[1]);
	assertFacadeAssociation(replacementAdapter, session);
	assertRegistryNames(replacementAdapter, replacementRegistry);
	assert.equal(replacementAdapter.getToolDefinition(PTC_TOOL_NAME), replacementDefinition);
	installation.teardown();
});

test("retained capability facades reject after reload without invoking raw capabilities", async () => {
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const rawCalls = {
		createContext: 0,
		emit: 0,
		getActiveTools: 0,
		setActiveTools: 0,
		refreshTools: 0,
		prepareArguments: 0,
		execute: 0,
		beforeToolCall: 0,
		afterToolCall: 0,
	};
	const { Session } = createFakeSessionClass({
		onReload(session) {
			session.extensionRunner = createRunner();
			session._toolRegistry = new Map([[SECOND_TOOL_NAME, createTool()]]);
			session.agent.beforeToolCall = async () => undefined;
			session.agent.afterToolCall = async () => undefined;
			session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
		},
	});
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	const session = new Session();
	const rawRunner = session.extensionRunner;
	const rawRuntime = rawRunner.runtime;
	const rawTool = session._toolRegistry.get(SAMPLE_TOOL_NAME);
	assert.ok(rawTool);
	rawRunner.createContext = () => {
		rawCalls.createContext += 1;
		return {};
	};
	rawRunner.emit = async () => {
		rawCalls.emit += 1;
	};
	rawRuntime.getActiveTools = () => {
		rawCalls.getActiveTools += 1;
		return [SAMPLE_TOOL_NAME];
	};
	rawRuntime.setActiveTools = () => {
		rawCalls.setActiveTools += 1;
	};
	rawRuntime.refreshTools = () => {
		rawCalls.refreshTools += 1;
	};
	rawTool.prepareArguments = (args) => {
		rawCalls.prepareArguments += 1;
		return args;
	};
	rawTool.execute = async () => {
		rawCalls.execute += 1;
		return {};
	};
	session.agent.beforeToolCall = async () => {
		rawCalls.beforeToolCall += 1;
	};
	session.agent.afterToolCall = async () => {
		rawCalls.afterToolCall += 1;
	};
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
	await session.bindExtensions();
	const adapter = assertCompatible(captures[0]);
	const runner = adapter.extensionRunner;
	const runtime = adapter.sharedRuntime;
	const registry = adapter.toolRegistry;
	const tool = registry.get(SAMPLE_TOOL_NAME);
	assert.ok(tool);
	const beforeToolCall = adapter.beforeToolCall;
	const afterToolCall = adapter.afterToolCall;
	const getToolDefinition = adapter.getToolDefinition;
	const retainedEntries = registry.entries();

	await session.reload();

	const staleOperations = [
		() => runner.createContext(),
		() => runner.emit({ type: "agent_settled" }),
		() => runtime.getActiveTools(),
		() => runtime.setActiveTools([]),
		() => runtime.refreshTools(),
		() => registry.size,
		() => registry.get(SAMPLE_TOOL_NAME),
		() => registry.has(SAMPLE_TOOL_NAME),
		() => registry.forEach(() => {}),
		() => registry.entries(),
		() => registry.keys(),
		() => registry.values(),
		() => registry[Symbol.iterator](),
		() => retainedEntries.next(),
		() => tool.parameters,
		() => tool.executionMode,
		() => tool.prepareArguments,
		() => tool.execute(CHARACTERIZATION_TOOL_CALL_ID, {}),
		() => beforeToolCall({}),
		() => afterToolCall({}),
		() => getToolDefinition(PTC_TOOL_NAME),
	];
	for (const operation of staleOperations) {
		assert.throws(operation, STALE_CAPTURE_PATTERN);
	}
	assert.deepEqual(rawCalls, {
		createContext: 0,
		emit: 0,
		getActiveTools: 0,
		setActiveTools: 0,
		refreshTools: 0,
		prepareArguments: 0,
		execute: 0,
		beforeToolCall: 0,
		afterToolCall: 0,
	});
	installation.teardown();
});

test("retained capability facades reject after teardown", async () => {
	const { Session } = createFakeSessionClass();
	const captures: PiRuntimeCapture[] = [];
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	if (!installation.compatible) throw new Error("expected compatible installation");
	const session = new Session();
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, createInstaller(captures));
	await session.bindExtensions();
	const adapter = assertCompatible(captures[0]);
	const runner = adapter.extensionRunner;
	const runtime = adapter.sharedRuntime;
	const registry = adapter.toolRegistry;
	const tool = registry.get(SAMPLE_TOOL_NAME);
	assert.ok(tool);
	const beforeToolCall = adapter.beforeToolCall;
	const afterToolCall = adapter.afterToolCall;

	installation.teardown();

	for (const operation of [
		() => runner.createContext(),
		() => runtime.getActiveTools(),
		() => registry.get(SAMPLE_TOOL_NAME),
		() => tool.execute(CHARACTERIZATION_TOOL_CALL_ID, {}),
		() => beforeToolCall({}),
		() => afterToolCall({}),
	]) {
		assert.throws(operation, STALE_CAPTURE_PATTERN);
	}
});

test("tag removal and invalid rebinding leave earlier generations stale", async () => {
	const { Session } = createFakeSessionClass();
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	const session = new Session();
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
	await session.bindExtensions();
	const taggedAdapter = assertCompatible(captures[0]);

	session.ptcDefinition = { name: PTC_TOOL_NAME };
	await session.bindExtensions();

	assert.equal(captures.length, EXPECTED_CAPTURE_COUNT);
	assertStale(taggedAdapter);

	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
	await session.bindExtensions();
	const reboundAdapter = assertCompatible(captures[1]);
	(session.extensionRunner as unknown as { emit: unknown }).emit = undefined;

	await session.bindExtensions();

	assert.equal(captures.length, EXPECTED_REBIND_CAPTURE_COUNT + EXPECTED_CAPTURE_COUNT);
	assertIncompatible(captures[2], /emit/);
	assertStale(reboundAdapter);
	installation.teardown();
});

test("older bind success invalidates a newer reload capture instead of retargeting it", async () => {
	const olderGate = createDeferred();
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const olderRunner = createRunner();
	const olderRegistry = new Map([[SAMPLE_TOOL_NAME, createTool()]]);
	const newerRunner = createRunner();
	const newerRegistry = new Map([[SECOND_TOOL_NAME, createTool()]]);
	const { Session } = createFakeSessionClass({
		async onBind(session) {
			await olderGate.promise;
			session.extensionRunner = olderRunner;
			session._toolRegistry = olderRegistry;
			session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
		},
		onReload(session) {
			session.extensionRunner = newerRunner;
			session._toolRegistry = newerRegistry;
			session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
		},
	});
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	const session = new Session();
	const olderBind = session.bindExtensions();

	assert.equal(await session.reload(), RELOAD_RESULT);
	assert.equal(captures.length, EXPECTED_CAPTURE_COUNT);
	const newerAdapter = assertCompatible(captures[0]);
	assertFacadeAssociation(newerAdapter, session);
	assertRegistryNames(newerAdapter, newerRegistry);

	olderGate.resolve();
	assert.equal(await olderBind, ORIGINAL_RESULT);

	assert.equal(captures.length, EXPECTED_CAPTURE_COUNT);
	assertStale(newerAdapter);
	installation.teardown();
});

test("older bind rejection invalidates a newer reload capture", async () => {
	const olderGate = createDeferred();
	const rejection = new Error(ORIGINAL_ERROR);
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const { Session } = createFakeSessionClass({
		async onBind(session) {
			await olderGate.promise;
			session.extensionRunner = createRunner();
			session._toolRegistry = new Map([[SAMPLE_TOOL_NAME, createTool()]]);
			throw rejection;
		},
		onReload(session) {
			session.extensionRunner = createRunner();
			session._toolRegistry = new Map([[SECOND_TOOL_NAME, createTool()]]);
			session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
		},
	});
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	const session = new Session();
	const olderBind = session.bindExtensions();

	await session.reload();
	const newerAdapter = assertCompatible(captures[0]);
	assertFacadeAssociation(newerAdapter, session);

	olderGate.resolve();
	await assert.rejects(olderBind, (error) => error === rejection);

	assert.equal(captures.length, EXPECTED_CAPTURE_COUNT);
	assertStale(newerAdapter);
	installation.teardown();
});

test("older completion leaves a newer in-flight invocation able to publish", async () => {
	const olderGate = createDeferred();
	const newerGate = createDeferred();
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const newerRunner = createRunner();
	const newerRegistry = new Map([[SECOND_TOOL_NAME, createTool()]]);
	const { Session } = createFakeSessionClass({
		async onBind(session) {
			await olderGate.promise;
			session.extensionRunner = createRunner();
			session._toolRegistry = new Map([[SAMPLE_TOOL_NAME, createTool()]]);
		},
		async onReload(session) {
			await newerGate.promise;
			session.extensionRunner = newerRunner;
			session._toolRegistry = newerRegistry;
			session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
		},
	});
	const installation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(installation.compatible, true);
	const session = new Session();
	const olderBind = session.bindExtensions();
	const newerReload = session.reload();

	olderGate.resolve();
	assert.equal(await olderBind, ORIGINAL_RESULT);
	assert.deepEqual(captures, []);

	newerGate.resolve();
	assert.equal(await newerReload, RELOAD_RESULT);
	const newerAdapter = assertCompatible(captures[0]);
	assertFacadeAssociation(newerAdapter, session);
	assertRegistryNames(newerAdapter, newerRegistry);
	installation.teardown();
});

test("old patch completion invalidates a newer capture after teardown and reinstall", async () => {
	const olderGate = createDeferred();
	const captures: PiRuntimeCapture[] = [];
	const installer = createInstaller(captures);
	const olderRunner = createRunner();
	const olderRegistry = new Map([[SAMPLE_TOOL_NAME, createTool()]]);
	const newerRunner = createRunner();
	const newerRegistry = new Map([[SECOND_TOOL_NAME, createTool()]]);
	let bindCalls = 0;
	const { Session } = createFakeSessionClass({
		async onBind(session) {
			bindCalls += 1;
			if (bindCalls === EXPECTED_CAPTURE_COUNT) return;
			await olderGate.promise;
			session.extensionRunner = olderRunner;
			session._toolRegistry = olderRegistry;
			session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
		},
		onReload(session) {
			session.extensionRunner = newerRunner;
			session._toolRegistry = newerRegistry;
			session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
		},
	});
	const firstInstallation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(firstInstallation.compatible, true);
	if (!firstInstallation.compatible) throw new Error("expected compatible installation");
	const session = new Session();
	session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
	await session.bindExtensions();
	const oldAdapter = assertCompatible(captures[0]);

	const olderBind = session.bindExtensions();
	assertStale(oldAdapter);
	firstInstallation.teardown();
	assertStale(oldAdapter);

	const secondInstallation = installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
	});
	assert.equal(secondInstallation.compatible, true);
	if (!secondInstallation.compatible) throw new Error("expected compatible reinstallation");
	await session.reload();
	assert.equal(captures.length, EXPECTED_REBIND_CAPTURE_COUNT);
	const newAdapter = assertCompatible(captures[1]);
	assertFacadeAssociation(newAdapter, session);
	assertRegistryNames(newAdapter, newerRegistry);

	olderGate.resolve();
	assert.equal(await olderBind, ORIGINAL_RESULT);

	assert.equal(captures.length, EXPECTED_REBIND_CAPTURE_COUNT);
	assertStale(oldAdapter);
	assertStale(newAdapter);
	secondInstallation.teardown();
});

test("adapter invalidates when captured generation identities or tag change", async () => {
	const cases: Array<{
		name: string;
		mutate(session: FakeSessionShape, installer: PiRuntimeInstaller): void;
	}> = [
		{
			name: "extension runner",
			mutate: (session) => {
				session.extensionRunner = createRunner();
			},
		},
		{
			name: "shared runtime",
			mutate: (session) => {
				session.extensionRunner.runtime = createRunner().runtime;
			},
		},
		{
			name: "tool registry",
			mutate: (session) => {
				session._toolRegistry = new Map([[SECOND_TOOL_NAME, createTool()]]);
			},
		},
		{
			name: "before hook",
			mutate: (session) => {
				session.agent.beforeToolCall = async () => undefined;
			},
		},
		{
			name: "after hook",
			mutate: (session) => {
				session.agent.afterToolCall = async () => undefined;
			},
		},
		{
			name: "tool lookup",
			mutate: (session) => {
				session.getToolDefinition = (name) =>
					name === PTC_TOOL_NAME ? session.ptcDefinition : undefined;
			},
		},
		{
			name: "tagged definition",
			mutate: (session, installer) => {
				session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
			},
		},
		{
			name: "installer tag",
			mutate: (session) => {
				assert.ok(session.ptcDefinition);
				tagPtcToolDefinition(session.ptcDefinition, createInstaller([]));
			},
		},
	];

	for (const testCase of cases) {
		const captures: PiRuntimeCapture[] = [];
		const installer = createInstaller(captures);
		const { Session } = createFakeSessionClass();
		const installation = installPiRuntimeCapturePatch({
			agentSession: Session,
			version: SUPPORTED_PI_VERSION,
		});
		assert.equal(installation.compatible, true, testCase.name);
		const session = new Session();
		session.ptcDefinition = tagPtcToolDefinition({ name: PTC_TOOL_NAME }, installer);
		await session.bindExtensions();
		const adapter = assertCompatible(captures[0]);

		testCase.mutate(session, installer);

		assertStale(adapter);
		assertStale(adapter);
		installation.teardown();
	}
});

test("adapter stales when a captured registry entry or field mutates in place", async () => {
	const cases: Array<{
		name: string;
		mutate(registry: Map<string, FakeTool>, tool: FakeTool): void;
	}> = [
		{
			name: "entry identity",
			mutate: (registry) => {
				registry.set(SAMPLE_TOOL_NAME, createTool());
			},
		},
		{
			name: "parameters identity",
			mutate: (_registry, tool) => {
				tool.parameters = { changed: true };
			},
		},
		{
			name: "prepareArguments identity",
			mutate: (_registry, tool) => {
				tool.prepareArguments = () => ({ changed: true });
			},
		},
		{
			name: "executionMode value",
			mutate: (_registry, tool) => {
				tool.executionMode = "sequential";
			},
		},
		{
			name: "execute identity",
			mutate: (_registry, tool) => {
				tool.execute = async () => ({ changed: true });
			},
		},
		{
			name: "registry membership",
			mutate: (registry) => {
				registry.set(SECOND_TOOL_NAME, createTool());
			},
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
		const session = new Session();
		session.ptcDefinition = tagPtcToolDefinition(
			{ name: PTC_TOOL_NAME },
			createInstaller(captures),
		);
		await session.bindExtensions();
		const adapter = assertCompatible(captures[0]);
		const facadeTool = adapter.toolRegistry.get(SAMPLE_TOOL_NAME);
		const rawTool = session._toolRegistry.get(SAMPLE_TOOL_NAME);
		assert.ok(facadeTool, testCase.name);
		assert.ok(rawTool, testCase.name);

		testCase.mutate(session._toolRegistry, rawTool);

		assertStale(adapter);
		assert.throws(
			() => facadeTool.execute(CHARACTERIZATION_TOOL_CALL_ID, {}),
			STALE_CAPTURE_PATTERN,
		);
		installation.teardown();
	}
});

test("adapter stales when captured owner methods mutate in place", async () => {
	const cases: Array<{
		name: string;
		mutate(session: FakeSessionShape): void;
	}> = [
		{
			name: "runner createContext",
			mutate: (session) => {
				session.extensionRunner.createContext = () => ({ changed: true });
			},
		},
		{
			name: "runner emit",
			mutate: (session) => {
				session.extensionRunner.emit = async () => undefined;
			},
		},
		{
			name: "runtime getActiveTools",
			mutate: (session) => {
				session.extensionRunner.runtime.getActiveTools = () => [];
			},
		},
		{
			name: "runtime setActiveTools",
			mutate: (session) => {
				session.extensionRunner.runtime.setActiveTools = () => undefined;
			},
		},
		{
			name: "runtime refreshTools",
			mutate: (session) => {
				session.extensionRunner.runtime.refreshTools = () => undefined;
			},
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
		const session = new Session();
		session.ptcDefinition = tagPtcToolDefinition(
			{ name: PTC_TOOL_NAME },
			createInstaller(captures),
		);
		await session.bindExtensions();
		const adapter = assertCompatible(captures[0]);

		testCase.mutate(session);

		assertStale(adapter);
		installation.teardown();
	}
});

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

test("imported Pi version remains authoritative over a supported caller assertion", () => {
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

	const result = getVersionDiagnostic(UNSUPPORTED_PI_VERSION, SUPPORTED_PI_VERSION);

	assert.match(result ?? "", /0\.84\.2/);
	assert.match(result ?? "", /0\.84\.3/);
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
	assert.match(installation.diagnostic, /0\.84\.3/);
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

test("teardown during deferred reload keeps prior generation stale without a late capture", async () => {
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
		assertStale(firstAdapter);
	} finally {
		installation.teardown();
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
	const { Session } = createFakeSessionClass({
		onReload() {
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
	const firstAdapter = assertCompatible(captures[0]);

	await assert.rejects(session.reload(), (error) => error === rejection);

	assert.equal(captures.length, EXPECTED_CAPTURE_COUNT);
	assertStale(firstAdapter);
	installation.teardown();
});

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
