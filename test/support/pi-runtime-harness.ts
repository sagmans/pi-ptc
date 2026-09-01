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

import * as piRuntimeModule from "../../src/pi-runtime.ts";
import {
	ensureSharedPiRuntimeCapturePatch,
	installPiRuntimeCapturePatch,
	type PiRuntimeCapture,
	type PiRuntimeEventFinalizersInstallation,
	type PiRuntimeInstaller,
	type SupportedPiVersion,
	tagPtcToolDefinition,
} from "../../src/pi-runtime.ts";

export type { PiRuntimeCapture, PiRuntimeEventFinalizersInstallation, PiRuntimeInstaller };
export {
	AgentSession,
	assert,
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	ensureSharedPiRuntimeCapturePatch,
	installPiRuntimeCapturePatch,
	join,
	ModelRuntime,
	mkdirSync,
	mkdtempSync,
	piRuntimeModule,
	readFileSync,
	rmSync,
	SessionManager,
	SettingsManager,
	Type,
	tagPtcToolDefinition,
	test,
	tmpdir,
	VERSION,
};

export const SUPPORTED_PI_VERSION = VERSION as SupportedPiVersion;
export const BIND_EXTENSIONS_PROPERTY = "bindExtensions";
export const RELOAD_PROPERTY = "reload";
export const EMIT_TOOL_CALL_PROPERTY = "emitToolCall";
export const EMIT_BEFORE_AGENT_START_PROPERTY = "emitBeforeAgentStart";
export const PTC_TOOL_NAME = "ptc";
export const SAMPLE_TOOL_NAME = "sample";
export const SECOND_TOOL_NAME = "second";
export const UNSUPPORTED_PI_VERSION = "0.84.2";
export const ORIGINAL_RESULT = "original-result";
export const RELOAD_RESULT = "reload-result";
export const ORIGINAL_ERROR = "planned bind failure";
export const EXPECTED_CAPTURE_COUNT = 1;
export const EXPECTED_REBIND_CAPTURE_COUNT = 2;
export const EXPECTED_ORIGINAL_CALL_COUNT = 2;
export const STALE_CAPTURE_PATTERN = /no longer associated/;
export const GLOBAL_REGISTRY_PATTERN = /global registry/i;
export const PATCH_REGISTRY_SYMBOL = Symbol.for("pi-ptc.pi-runtime.patch-registry.v1");
export const COORDINATOR_REGISTRY_SYMBOL = Symbol.for(
	"pi-ptc.pi-runtime.lifecycle-coordinator-registry.v1",
);
export const SHARED_PATCH_LEASE_REGISTRY_SYMBOL = Symbol.for(
	"pi-ptc.pi-runtime.shared-patch-lease-registry.v1",
);
export const CHARACTERIZATION_DIRECTORY_PREFIX = "pi-ptc-runtime-characterization-";
export const CHARACTERIZATION_TOOL_RESULT = "characterized";
export const CHARACTERIZATION_TOOL_CALL_ID = "characterization-call";
export const CALLBACK_FAILURE_MESSAGE = "planned capture callback failure";
export const PACKAGE_JSON_PATH = new URL("../../package.json", import.meta.url);
export const PACKAGE_LOCK_PATH = new URL("../../package-lock.json", import.meta.url);

export type FakeTool = {
	parameters: object;
	prepareArguments?: (args: unknown) => unknown;
	executionMode?: "parallel" | "sequential";
	execute: () => Promise<object>;
};

export type FakeRunner = {
	createContext: () => object;
	emit: () => Promise<void>;
	emitToolCall: (...args: unknown[]) => Promise<unknown>;
	emitBeforeAgentStart: (...args: unknown[]) => Promise<unknown>;
	runtime: {
		getActiveTools: () => string[];
		setActiveTools: (names: string[]) => void;
		refreshTools: () => void;
	};
};

export type FakeSessionShape = {
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

export type FakeSessionConstructor = {
	new (): FakeSessionShape;
	prototype: FakeSessionShape;
};

export type FakeSessionOptions = {
	throwOnBind?: boolean;
	onBind?: (session: FakeSessionShape) => void | Promise<void>;
	onReload?: (session: FakeSessionShape) => void | Promise<void>;
};

export function createTool(overrides: Partial<FakeTool> = {}): FakeTool {
	return {
		parameters: { type: "object" },
		prepareArguments: (args) => args,
		executionMode: "parallel",
		execute: async () => ({}),
		...overrides,
	};
}

export function createRunner(
	onSetActiveTools?: () => void,
	events: {
		emitToolCall?: (...args: unknown[]) => Promise<unknown>;
		emitBeforeAgentStart?: (...args: unknown[]) => Promise<unknown>;
	} = {},
): FakeRunner {
	class FakeRunnerImplementation implements FakeRunner {
		runtime = {
			getActiveTools: () => [SAMPLE_TOOL_NAME],
			setActiveTools: () => onSetActiveTools?.(),
			refreshTools: () => undefined,
		};

		createContext(): object {
			return { cwd: "/tmp" };
		}

		async emit(): Promise<void> {}

		async emitToolCall(...args: unknown[]): Promise<unknown> {
			return events.emitToolCall?.(...args);
		}

		async emitBeforeAgentStart(...args: unknown[]): Promise<unknown> {
			return events.emitBeforeAgentStart?.(...args);
		}
	}

	return new FakeRunnerImplementation();
}

export function createInstaller(captures: PiRuntimeCapture[]): PiRuntimeInstaller {
	return {
		capturePiRuntime(capture) {
			captures.push(capture);
		},
	};
}

export function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

export function createFakeSessionClass(options: FakeSessionOptions = {}): {
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

export function assertCompatible(capture: PiRuntimeCapture | undefined) {
	assert.ok(capture);
	assert.equal(capture.compatible, true);
	return capture.session;
}

export function assertIncompatible(capture: PiRuntimeCapture | undefined, expected: RegExp): void {
	assert.ok(capture);
	assert.equal(capture.compatible, false);
	if (capture.compatible) throw new Error("expected incompatible capture");
	assert.match(capture.diagnostic, expected);
}

export function assertFacadeAssociation(
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

export function assertRegistryNames(
	adapter: ReturnType<typeof assertCompatible>,
	expected: ReadonlyMap<string, unknown>,
): void {
	assert.deepEqual([...adapter.toolRegistry.keys()], [...expected.keys()]);
}

export function assertStale(adapter: ReturnType<typeof assertCompatible>): void {
	const accesses = [
		() => adapter.version,
		() => adapter.extensionRunner,
		() => adapter.sharedRuntime,
		() => adapter.toolRegistry,
		() => adapter.beforeToolCall,
		() => adapter.afterToolCall,
		() => adapter.getToolDefinition(PTC_TOOL_NAME),
		() =>
			adapter.installRuntimeEventFinalizers({
				finalizeToolCall: async (_args, result) => result,
				finalizeBeforeAgentStart: async (_args, result) => result,
			}),
	];
	for (const access of accesses) {
		assert.throws(access, STALE_CAPTURE_PATTERN);
	}
}
