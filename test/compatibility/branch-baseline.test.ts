import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { VERSION } from "@earendil-works/pi-coding-agent";
import { SHIPPED_PTC_CONFIG, TRANSPORT_NAME } from "../../src/config.ts";
import { createSnapshotDetails, parseDispatchDetails } from "../../src/dispatch-details.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/host.ts";
import {
	adaptLegacyCapturedPiSession,
	ensureSharedPiRuntimeCapturePatch,
	installPiRuntimeCapturePatch,
	tagPtcToolDefinition,
} from "../../src/pi-runtime.ts";
import type {
	PiRuntimeCapture,
	PiRuntimePatchInstallation,
} from "../../src/pi-runtime-contract.ts";
import { createPtcLifecycle } from "../../src/ptc-lifecycle.ts";
import { createFailureDetailsStore } from "../../src/transport.ts";
import {
	createFakeSessionClass,
	createTool,
	STALE_CAPTURE_PATTERN,
} from "../support/pi-runtime-harness.ts";
import { loadBaselineModule, withBaselineCheckout } from "./baseline-runner.ts";
import {
	hasPiRuntimeV1CoordinatorShape,
	PI_RUNTIME_V1_SYMBOL_NAMES,
	readPiRuntimeV1Registry,
	snapshotPiRuntimeV1Peer,
} from "./pi-runtime-v1-peer.ts";

const BASELINE_PI_VERSION = "0.84.3";
const INSTALLED_PI_VERSION: string = VERSION;
const BASELINE_RUNTIME_PATH = "src/pi-runtime.ts";
const BASELINE_DETAILS_PATH = "src/dispatch-details.ts";
const BASELINE_WORKER_PATH = "src/worker.ts";
const MIXED_COPY_INSTALLATIONS = 2;
const SHARED_PATCH_INSTALLATIONS = 1;
const MIXED_TOOL_NAME = "sample";
const COMPATIBILITY_CWD = "/tmp";
const BASELINE_WORKER_SETTLEMENT_MS = 150;
const BASELINE_WORKER_TIMEOUT_MS = 5_000;
const DELIVERY_TOOL_NAME = "delivery";
const DELIVERY_MESSAGE = "delivery failed after execution";

type RuntimeModule = {
	ensureSharedPiRuntimeCapturePatch(options: {
		agentSession: { prototype: object };
		version: string;
		globalObject: object;
	}): { compatible: true } | { compatible: false; diagnostic: string };
	installPiRuntimeCapturePatch(options: {
		agentSession: { prototype: object };
		version: string;
		globalObject: object;
	}): PiRuntimePatchInstallation;
	tagPtcToolDefinition(definition: object, installer: object): void;
};

type DetailsModule = {
	createSnapshotDetails(
		description: string,
		dispatches: readonly unknown[],
		executionError?: string,
		maxRenderDetailsBytes?: number,
	): unknown;
	parseDispatchDetails(value: unknown): unknown;
};

type PatchState = {
	installations: number;
};

function assertCompatibleCapture(capture: PiRuntimeCapture | undefined) {
	assert.ok(capture);
	if (!capture.compatible) assert.fail(capture.diagnostic);
	return capture.session;
}

function registryInstallations(globalObject: object, prototype: object): number | undefined {
	const registry = readPiRuntimeV1Registry(globalObject, "patchRegistry");
	const state = registry?.get(prototype) as PatchState | undefined;
	return state?.installations;
}

async function proveSharedPatchOrder(first: RuntimeModule, second: RuntimeModule): Promise<void> {
	const { Session } = createFakeSessionClass();
	const globalObject = {};
	const captures: PiRuntimeCapture[] = [];
	const installer = {
		capturePiRuntime(capture: PiRuntimeCapture) {
			captures.push(capture);
		},
	};
	const definition = {};
	second.tagPtcToolDefinition(definition, installer);
	const session = new Session();
	session.ptcDefinition = definition;
	const firstEnsure = first.ensureSharedPiRuntimeCapturePatch({
		agentSession: Session,
		version: INSTALLED_PI_VERSION,
		globalObject,
	});
	const secondEnsure = second.ensureSharedPiRuntimeCapturePatch({
		agentSession: Session,
		version: INSTALLED_PI_VERSION,
		globalObject,
	});
	assert.equal(firstEnsure.compatible, true);
	assert.equal(secondEnsure.compatible, true);
	assert.equal(registryInstallations(globalObject, Session.prototype), SHARED_PATCH_INSTALLATIONS);

	await session.bindExtensions();
	const captured = adaptLegacyCapturedPiSession(assertCompatibleCapture(captures[0]));
	assert.ok(captured);
	assert.equal(captured.prepareToolArguments(MIXED_TOOL_NAME, {}).ok, true);
	await session.reload();
	assert.throws(() => captured.prepareToolArguments(MIXED_TOOL_NAME, {}), STALE_CAPTURE_PATTERN);
	const reloaded = adaptLegacyCapturedPiSession(assertCompatibleCapture(captures[1]));
	assert.ok(reloaded);
	assert.equal(reloaded.prepareToolArguments(MIXED_TOOL_NAME, {}).ok, true);
}

async function proveSharedLifecycleOrder(
	first: RuntimeModule,
	second: RuntimeModule,
): Promise<void> {
	const { Session } = createFakeSessionClass();
	const globalObject = {};
	const session = new Session();
	session._toolRegistry.set(TRANSPORT_NAME, createTool());
	const runtime = session.extensionRunner.runtime;
	let activeTools = [MIXED_TOOL_NAME];
	runtime.getActiveTools = () => [...activeTools];
	runtime.setActiveTools = (names) => {
		activeTools = names.filter((name) => session._toolRegistry.has(name));
	};
	const pi: ExtensionAPI = {
		registerTool() {},
		registerCommand() {},
		on() {},
		setActiveTools(names) {
			runtime.setActiveTools(names);
		},
		getActiveTools: () => runtime.getActiveTools(),
		getAllTools: () => [...session._toolRegistry.keys()].map((name) => ({ name })),
		appendEntry() {},
		events: { emit() {} },
	};
	const notifications: string[] = [];
	const context: ExtensionContext = {
		cwd: COMPATIBILITY_CWD,
		ui: { notify: (message) => void notifications.push(message), setStatus() {} },
		isProjectTrusted: () => true,
	};
	const lifecycle = createPtcLifecycle({
		pi,
		initialPresentation: SHIPPED_PTC_CONFIG.presentation,
		maxParallelDispatches: SHIPPED_PTC_CONFIG.maxParallelDispatches,
		failureDetails: createFailureDetailsStore(),
		clearRenderSnapshots() {},
	});
	let captureCount = 0;
	const installer = {
		capturePiRuntime(capture: PiRuntimeCapture) {
			captureCount += 1;
			lifecycle.capture(capture);
		},
	};
	const definition = {};
	second.tagPtcToolDefinition(definition, installer);
	session.ptcDefinition = definition;
	lifecycle.sessionStart(context, SHIPPED_PTC_CONFIG.presentation);
	for (const runtimeModule of [first, second]) {
		const ensured = runtimeModule.ensureSharedPiRuntimeCapturePatch({
			agentSession: Session,
			version: INSTALLED_PI_VERSION,
			globalObject,
		});
		assert.equal(ensured.compatible, true);
	}

	await session.bindExtensions();
	assert.equal(captureCount, 1);
	assert.deepEqual(notifications, []);
	const firstLease = lifecycle.issueExecutionLease();
	const firstResult = await firstLease.dispatch.dispatch({ name: MIXED_TOOL_NAME, args: {} });
	assert.equal(firstResult.isError, false);
	lifecycle.clear("reload");
	assert.throws(firstLease.assertCurrent, /capture|unavailable/i);
	firstLease.release();
	await session.reload();
	assert.equal(captureCount, 2);
	assert.deepEqual(notifications, []);
	const secondLease = lifecycle.issueExecutionLease();
	const secondResult = await secondLease.dispatch.dispatch({ name: MIXED_TOOL_NAME, args: {} });
	assert.equal(secondResult.isError, false);
	secondLease.release();
	lifecycle.clear("teardown");
}

async function proveMixedOrder(first: RuntimeModule, second: RuntimeModule): Promise<void> {
	const { Session, originalDescriptor, originalReloadDescriptor } = createFakeSessionClass();
	const globalObject = {};
	const captures: PiRuntimeCapture[] = [];
	const installer = {
		capturePiRuntime(capture: PiRuntimeCapture) {
			captures.push(capture);
		},
	};
	const definition = {};
	first.tagPtcToolDefinition(definition, installer);
	const session = new Session();
	session.ptcDefinition = definition;
	const before = snapshotPiRuntimeV1Peer(globalObject, Session.prototype);
	const firstInstallation = first.installPiRuntimeCapturePatch({
		agentSession: Session,
		version: INSTALLED_PI_VERSION,
		globalObject,
	});
	const secondInstallation = second.installPiRuntimeCapturePatch({
		agentSession: Session,
		version: INSTALLED_PI_VERSION,
		globalObject,
	});
	assert.equal(firstInstallation.compatible, true);
	assert.equal(secondInstallation.compatible, true);
	assert.equal(registryInstallations(globalObject, Session.prototype), MIXED_COPY_INSTALLATIONS);
	const installed = snapshotPiRuntimeV1Peer(globalObject, Session.prototype);
	assert.ok(installed.registryDescriptors.get(PI_RUNTIME_V1_SYMBOL_NAMES.patchRegistry));

	await session.bindExtensions();
	const coordinator = readPiRuntimeV1Registry(globalObject, "lifecycleCoordinatorRegistry")?.get(
		Session.prototype,
	);
	assert.equal(hasPiRuntimeV1CoordinatorShape(coordinator), true);
	const firstSession = assertCompatibleCapture(captures[0]);
	firstInstallation.compatible && firstInstallation.teardown();
	assert.equal(registryInstallations(globalObject, Session.prototype), 1);
	await session.reload();
	assert.throws(() => firstSession.toolRegistry, STALE_CAPTURE_PATTERN);
	assertCompatibleCapture(captures[1]);
	secondInstallation.compatible && secondInstallation.teardown();

	assert.deepEqual(
		Object.getOwnPropertyDescriptor(Session.prototype, "bindExtensions"),
		originalDescriptor,
	);
	assert.deepEqual(
		Object.getOwnPropertyDescriptor(Session.prototype, "reload"),
		originalReloadDescriptor,
	);
	assert.equal(
		readPiRuntimeV1Registry(globalObject, "patchRegistry")?.has(Session.prototype),
		false,
	);
	const after = snapshotPiRuntimeV1Peer(globalObject, Session.prototype);
	assert.deepEqual(after.lifecycleDescriptors, before.lifecycleDescriptors);
}

test("baseline runtime compatibility follows the installed verified Pi version", async () => {
	const baseline = (await loadBaselineModule(BASELINE_RUNTIME_PATH)) as RuntimeModule;
	const target: RuntimeModule = {
		ensureSharedPiRuntimeCapturePatch,
		installPiRuntimeCapturePatch,
		tagPtcToolDefinition,
	};
	if (INSTALLED_PI_VERSION === BASELINE_PI_VERSION) {
		await proveMixedOrder(baseline, target);
		await proveMixedOrder(target, baseline);
		await proveSharedPatchOrder(baseline, target);
		await proveSharedPatchOrder(target, baseline);
		await proveSharedLifecycleOrder(baseline, target);
		await proveSharedLifecycleOrder(target, baseline);
		return;
	}

	const { Session } = createFakeSessionClass();
	const globalObject = {};
	const baselineInstallation = baseline.installPiRuntimeCapturePatch({
		agentSession: Session,
		version: INSTALLED_PI_VERSION,
		globalObject,
	});
	assert.equal(baselineInstallation.compatible, false);
	const targetInstallation = target.installPiRuntimeCapturePatch({
		agentSession: Session,
		version: INSTALLED_PI_VERSION,
		globalObject,
	});
	assert.equal(targetInstallation.compatible, true);
	if (targetInstallation.compatible) targetInstallation.teardown();
});

test("target details remain readable by baseline and baseline fixtures remain readable", async () => {
	const baseline = (await loadBaselineModule(BASELINE_DETAILS_PATH)) as DetailsModule;
	const dispatches = [
		{
			id: 1,
			name: "mcp",
			args: { search: "fixture" },
			status: "ok" as const,
			preview: "found",
			result: {
				content: [{ type: "text", text: "found" }],
				details: { mode: "search" },
				isError: false,
			},
		},
	];
	const targetDetails = createSnapshotDetails("rollback", dispatches);
	const baselineDetails = baseline.createSnapshotDetails("rollback", dispatches);
	assert.equal(JSON.stringify(targetDetails), JSON.stringify(baselineDetails));
	assert.deepEqual(
		baseline.parseDispatchDetails(JSON.parse(JSON.stringify(targetDetails))),
		targetDetails,
	);
	const baselineFixture = JSON.parse(
		readFileSync(
			new URL(`../fixtures/dispatch-details/version-2-success.json`, import.meta.url),
			"utf8",
		),
	) as unknown;
	assert.deepEqual(
		parseDispatchDetails(baselineFixture),
		baseline.parseDispatchDetails(baselineFixture),
	);
});

test("baseline worker ignores the distinct retry-unsafe delivery message", async () => {
	await withBaselineCheckout(async (directory) => {
		const worker = new Worker(join(directory, BASELINE_WORKER_PATH), {
			workerData: {
				program: `async function __ptc_main__(tools) { return await tools.${DELIVERY_TOOL_NAME}({}); }`,
				bindingNames: [DELIVERY_TOOL_NAME],
				maxOutputBytes: 1024,
				maxOutputLines: 10,
			},
		});
		const terminalMessages: unknown[] = [];
		let sawCall = false;
		try {
			await Promise.race([
				new Promise<void>((resolve, reject) => {
					worker.on("message", (message: unknown) => {
						if (
							typeof message === "object" &&
							message !== null &&
							(message as { type?: unknown }).type === "call"
						) {
							sawCall = true;
							worker.postMessage({
								type: "result-delivery",
								id: (message as { id: number }).id,
								kind: "result-delivery",
								toolName: DELIVERY_TOOL_NAME,
								message: DELIVERY_MESSAGE,
							});
							setTimeout(resolve, BASELINE_WORKER_SETTLEMENT_MS);
							return;
						}
						terminalMessages.push(message);
					});
					worker.once("error", reject);
				}),
				new Promise<never>((_resolve, reject) => {
					setTimeout(
						() => reject(new Error("baseline worker compatibility test timed out")),
						BASELINE_WORKER_TIMEOUT_MS,
					);
				}),
			]);
			assert.equal(sawCall, true);
			assert.deepEqual(terminalMessages, []);
		} finally {
			await worker.terminate();
		}
	});
});
