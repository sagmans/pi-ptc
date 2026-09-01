import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { createSnapshotDetails, parseDispatchDetails } from "../../src/dispatch-details.ts";
import {
	installPiRuntimeCapturePatch,
	SUPPORTED_PI_VERSION,
	tagPtcToolDefinition,
} from "../../src/pi-runtime.ts";
import type {
	PiRuntimeCapture,
	PiRuntimePatchInstallation,
} from "../../src/pi-runtime-contract.ts";
import { createFakeSessionClass, STALE_CAPTURE_PATTERN } from "../support/pi-runtime-harness.ts";
import { loadBaselineModule, withBaselineCheckout } from "./baseline-runner.ts";
import {
	hasPiRuntimeV1CoordinatorShape,
	PI_RUNTIME_V1_SYMBOL_NAMES,
	readPiRuntimeV1Registry,
	snapshotPiRuntimeV1Peer,
} from "./pi-runtime-v1-peer.ts";

const BASELINE_RUNTIME_PATH = "src/pi-runtime.ts";
const BASELINE_DETAILS_PATH = "src/dispatch-details.ts";
const BASELINE_WORKER_PATH = "src/worker.ts";
const MIXED_COPY_INSTALLATIONS = 2;
const BASELINE_WORKER_SETTLEMENT_MS = 150;
const BASELINE_WORKER_TIMEOUT_MS = 5_000;
const DELIVERY_TOOL_NAME = "delivery";
const DELIVERY_MESSAGE = "delivery failed after execution";

type RuntimeModule = {
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
		version: SUPPORTED_PI_VERSION,
		globalObject,
	});
	const secondInstallation = second.installPiRuntimeCapturePatch({
		agentSession: Session,
		version: SUPPORTED_PI_VERSION,
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

test("baseline and target Pi runtime copies interoperate in both load orders", async () => {
	const baseline = (await loadBaselineModule(BASELINE_RUNTIME_PATH)) as RuntimeModule;
	const target: RuntimeModule = {
		installPiRuntimeCapturePatch,
		tagPtcToolDefinition,
	};
	await proveMixedOrder(baseline, target);
	await proveMixedOrder(target, baseline);
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
