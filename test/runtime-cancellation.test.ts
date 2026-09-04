import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SHIPPED_PTC_CONFIG } from "../src/config.ts";
import { runCode } from "../src/runtime.ts";
import {
	ACTIVE_BINDING_CALL_LIMIT,
	ACTIVE_LIMIT_PROGRAM,
	deferred,
	EXCESS_BINDING_CALLS,
	LATE_BINDING_ERROR,
	LATE_WORKER_ACTIVITY_DELAY_MS,
	NEVER_SETTLING_DRAIN_TIMEOUT_MS,
	NEVER_SETTLING_TEST_TIMEOUT_MS,
	nextTurn,
	settledWithinDrainObservation,
	WORKER_TERMINATION_DRAIN_TIMEOUT_MS,
	WORKER_TERMINATION_TEST_TIMEOUT_MS,
} from "./support/runtime-harness.ts";

test("runCode returns after the drain deadline when an aborted binding never settles", {
	timeout: NEVER_SETTLING_TEST_TIMEOUT_MS,
}, async () => {
	const controller = new AbortController();
	const bindingStarted = deferred();
	const allowBindingToSettle = deferred();
	const pending = runCode({
		program: "await tools.hang(null); return 1;",
		bindings: {
			functions: {
				hang: async () => {
					bindingStarted.resolve();
					await allowBindingToSettle.promise;
					return null;
				},
			},
		},
		signal: controller.signal,
		drainTimeoutMs: NEVER_SETTLING_DRAIN_TIMEOUT_MS,
	});
	await bindingStarted.promise;
	controller.abort();

	const outcome = await pending;
	allowBindingToSettle.resolve();
	await nextTurn();

	assert.deepEqual(outcome.error, { kind: "abort" });
});

test("runCode terminates worker-authored activity before draining host bindings", {
	timeout: WORKER_TERMINATION_TEST_TIMEOUT_MS,
}, async () => {
	const controller = new AbortController();
	const directory = mkdtempSync(join(tmpdir(), "pi-ptc-worker-close-"));
	const markerPath = join(directory, "late-worker-activity.txt");
	const bindingStarted = deferred();
	const allowBindingToSettle = deferred();
	try {
		const pending = runCode({
			program: `
void tools.hang(null);
await new Promise((resolve) => setTimeout(resolve, ${LATE_WORKER_ACTIVITY_DELAY_MS}));
const { writeFile } = await import("node:fs/promises");
await writeFile(${JSON.stringify(markerPath)}, "late");
return null;
`,
			bindings: {
				functions: {
					hang: async () => {
						bindingStarted.resolve();
						await allowBindingToSettle.promise;
						return null;
					},
				},
			},
			signal: controller.signal,
			drainTimeoutMs: WORKER_TERMINATION_DRAIN_TIMEOUT_MS,
		});
		await bindingStarted.promise;
		controller.abort();
		const outcome = await pending;
		assert.deepEqual(outcome.error, { kind: "abort" });
		assert.equal(existsSync(markerPath), false);
	} finally {
		allowBindingToSettle.resolve();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("runCode waits for an abort-aware binding after outer abort", async () => {
	const controller = new AbortController();
	const bindingStarted = deferred();
	const bindingAbortObserved = deferred();
	const allowBindingToSettle = deferred();
	let bindingSettled = false;
	const pending = runCode({
		program: "await tools.hang(null); return 1;",
		bindings: {
			functions: {
				hang: async (_args, signal) => {
					bindingStarted.resolve();
					if (!signal.aborted) {
						await new Promise<void>((resolve) => {
							signal.addEventListener("abort", () => resolve(), { once: true });
						});
					}
					bindingAbortObserved.resolve();
					await allowBindingToSettle.promise;
					bindingSettled = true;
					return null;
				},
			},
		},
		signal: controller.signal,
	});
	await bindingStarted.promise;
	controller.abort();
	await bindingAbortObserved.promise;
	const returnedBeforeDrain = await settledWithinDrainObservation(pending);
	allowBindingToSettle.resolve();
	const outcome = await pending;

	assert.equal(returnedBeforeDrain, false);
	assert.equal(bindingSettled, true);
	assert.deepEqual(outcome.error, { kind: "abort" });
});

test("runCode reports and drains a dangling fire-and-forget dispatch", async () => {
	const bindingStarted = deferred();
	const bindingAbortObserved = deferred();
	const allowBindingToSettle = deferred();
	let bindingSettled = false;
	const pending = runCode({
		program: "void tools.slow(null); return 1;",
		bindings: {
			functions: {
				slow: async (_args, signal) => {
					bindingStarted.resolve();
					if (!signal.aborted) {
						await new Promise<void>((resolve) => {
							signal.addEventListener("abort", () => resolve(), { once: true });
						});
					}
					bindingAbortObserved.resolve();
					await allowBindingToSettle.promise;
					bindingSettled = true;
					return null;
				},
			},
		},
	});
	await bindingStarted.promise;
	await bindingAbortObserved.promise;
	const returnedBeforeDrain = await settledWithinDrainObservation(pending);
	allowBindingToSettle.resolve();
	const outcome = await pending;

	assert.equal(returnedBeforeDrain, false);
	assert.equal(bindingSettled, true);
	assert.deepEqual(outcome.error, { kind: "dangling-dispatch" });
});

test("runCode uses the shipped maxDispatches default before invoking call 101", async () => {
	let bindingCalls = 0;
	const outcome = await runCode({
		program: `
for (let index = 0; index < ${EXCESS_BINDING_CALLS}; index += 1) {
  await tools.echo(index);
}
return "unreachable";
`,
		bindings: {
			functions: {
				echo: async (args) => {
					bindingCalls += 1;
					return args;
				},
			},
		},
	});

	assert.equal(bindingCalls, SHIPPED_PTC_CONFIG.maxDispatches);
	assert.deepEqual(outcome.error, { kind: "dispatch-limit" });
});

test("runCode aborts and drains active work when an override limit is exceeded", async () => {
	const firstStarted = deferred();
	const firstAbortObserved = deferred();
	const allowFirstToSettle = deferred();
	let firstSettled = false;
	let secondBindingCalls = 0;
	const pending = runCode({
		program: ACTIVE_LIMIT_PROGRAM,
		bindings: {
			functions: {
				first: async (_args, signal) => {
					firstStarted.resolve();
					if (!signal.aborted) {
						await new Promise<void>((resolve) => {
							signal.addEventListener("abort", () => resolve(), { once: true });
						});
					}
					firstAbortObserved.resolve();
					await allowFirstToSettle.promise;
					firstSettled = true;
					return null;
				},
				second: async () => {
					secondBindingCalls += 1;
					return null;
				},
			},
		},
		maxBindingCalls: ACTIVE_BINDING_CALL_LIMIT,
	});

	await firstStarted.promise;
	await firstAbortObserved.promise;
	const returnedBeforeDrain = await settledWithinDrainObservation(pending);
	allowFirstToSettle.resolve();
	const outcome = await pending;

	assert.equal(returnedBeforeDrain, false);
	assert.equal(firstSettled, true);
	assert.equal(secondBindingCalls, 0);
	assert.deepEqual(outcome.error, { kind: "dispatch-limit" });
});

test("runCode drains a late binding rejection without an unhandled rejection", async () => {
	const bindingStarted = deferred();
	const bindingAbortObserved = deferred();
	const unhandledRejections: unknown[] = [];
	let rejectBinding!: (error: Error) => void;
	const onUnhandledRejection = (error: unknown): void => {
		unhandledRejections.push(error);
	};
	process.on("unhandledRejection", onUnhandledRejection);
	try {
		const pending = runCode({
			program: "void tools.late(null); return null;",
			bindings: {
				functions: {
					late: (_args, signal) => {
						bindingStarted.resolve();
						if (signal.aborted) bindingAbortObserved.resolve();
						else {
							signal.addEventListener("abort", () => bindingAbortObserved.resolve(), {
								once: true,
							});
						}
						return new Promise<never>((_resolve, reject) => {
							rejectBinding = reject;
						});
					},
				},
			},
		});
		await bindingStarted.promise;
		await bindingAbortObserved.promise;
		rejectBinding(new Error(LATE_BINDING_ERROR));
		const outcome = await pending;
		await nextTurn();

		assert.deepEqual(outcome.error, { kind: "dangling-dispatch" });
		assert.deepEqual(unhandledRejections, []);
	} finally {
		process.removeListener("unhandledRejection", onUnhandledRejection);
	}
});
