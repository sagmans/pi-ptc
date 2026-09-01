import { strict as assert } from "node:assert";
import test from "node:test";

import { ToolResultDeliveryError } from "../src/canonical.ts";
import { runCode } from "../src/runtime.ts";
import {
	deferred,
	FIRST_WORKER_CALL_ID,
	HOSTILE_BINDING_NAME,
	hostileWorkerCallsProgram,
	hostileWorkerMessageProgram,
	INVALID_WORKER_CALL_ID_CASES,
	MALFORMED_WORKER_MESSAGES,
	RUNTIME_TEST_TIMEOUT_MS,
	settledWithinDrainObservation,
} from "./support/runtime-harness.ts";

test("runCode fails closed on malformed worker protocol messages", async () => {
	for (const message of MALFORMED_WORKER_MESSAGES) {
		const outcome = await runCode({
			program: hostileWorkerMessageProgram(message),
			timeoutMs: RUNTIME_TEST_TIMEOUT_MS,
		});

		assert.equal(outcome.error?.kind, "invalid-output", JSON.stringify(message));
	}
});

test("runCode rejects worker call IDs that are not positive, safe, and increasing", async () => {
	for (const testCase of INVALID_WORKER_CALL_ID_CASES) {
		let bindingCalls = 0;
		const outcome = await runCode({
			program: hostileWorkerCallsProgram(testCase.ids),
			bindings: {
				functions: {
					[HOSTILE_BINDING_NAME]: async (args) => {
						bindingCalls += 1;
						return args;
					},
				},
			},
			timeoutMs: RUNTIME_TEST_TIMEOUT_MS,
		});

		assert.equal(bindingCalls, testCase.expectedBindingCalls, testCase.name);
		assert.equal(outcome.error?.kind, "invalid-output", testCase.name);
	}
});

test("runCode preserves retry-unsafe result delivery failures", async () => {
	const outcome = await runCode({
		program:
			"try { await tools.delivery({}); } catch (error) { return { name: error.name, executionSucceeded: error.executionSucceeded, retryUnsafe: error.retryUnsafe }; }",
		bindings: {
			functions: {
				async delivery() {
					throw new ToolResultDeliveryError("delivery", "delivery failed");
				},
			},
		},
		timeoutMs: RUNTIME_TEST_TIMEOUT_MS,
	});
	assert.deepEqual(outcome, {
		logs: [],
		result: {
			name: "ToolResultDeliveryError",
			executionSucceeded: true,
			retryUnsafe: true,
		},
	});
});

test("runCode preserves uncaught retry-unsafe delivery failures", async () => {
	const outcome = await runCode({
		program: "return await tools.delivery({});",
		bindings: {
			functions: {
				async delivery() {
					throw new ToolResultDeliveryError("delivery", "delivery failed");
				},
			},
		},
		timeoutMs: RUNTIME_TEST_TIMEOUT_MS,
	});
	assert.deepEqual(outcome, {
		logs: [],
		error: { kind: "result-delivery", message: "delivery failed" },
	});
});

test("runCode rejects a duplicate worker call ID without replacing an active binding", async () => {
	const bindingStarted = deferred();
	const bindingAbortObserved = deferred();
	const allowBindingToSettle = deferred();
	let bindingCalls = 0;
	let bindingSettled = false;
	const pending = runCode({
		program: `
const pending = tools.${HOSTILE_BINDING_NAME}("first");
const { parentPort } = await import("node:worker_threads");
parentPort.postMessage({
  type: "call",
  id: ${FIRST_WORKER_CALL_ID},
  name: "${HOSTILE_BINDING_NAME}",
  args: "duplicate",
});
void pending;
return null;
`,
		bindings: {
			functions: {
				[HOSTILE_BINDING_NAME]: async (_args, signal) => {
					bindingCalls += 1;
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
		timeoutMs: RUNTIME_TEST_TIMEOUT_MS,
	});

	await bindingStarted.promise;
	await bindingAbortObserved.promise;
	const returnedBeforeDrain = await settledWithinDrainObservation(pending);
	const callsBeforeRelease = bindingCalls;
	allowBindingToSettle.resolve();
	const outcome = await pending;

	assert.equal(callsBeforeRelease, 1);
	assert.equal(returnedBeforeDrain, false);
	assert.equal(bindingSettled, true);
	assert.equal(outcome.error?.kind, "invalid-output");
});
