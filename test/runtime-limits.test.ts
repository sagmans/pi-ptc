import { strict as assert } from "node:assert";
import test from "node:test";

import { SHIPPED_PTC_CONFIG } from "../src/config.ts";
import { runCode } from "../src/runtime.ts";
import {
	CR_ONLY_WORKER_FAILURE_MESSAGE,
	deferred,
	NEVER_SETTLING_DRAIN_TIMEOUT_MS,
	NEVER_SETTLING_TIMEOUT_MS,
	nextTurn,
	ORPHAN_LIMIT,
	ORPHAN_RESERVATION_PROGRAM,
	OVERSIZED_WORKER_FAILURE_MESSAGE,
	RUNTIME_TEST_TIMEOUT_MS,
	settledWithinDrainObservation,
	WORKER_FAILURE_MAX_BYTES,
	WORKER_FAILURE_MAX_LINES,
} from "./support/runtime-harness.ts";

test("runCode reserves orphan capacity before parallel bindings start", async () => {
	const firstStarted = deferred();
	const firstAbortObserved = deferred();
	const allowFirstToSettle = deferred();
	let secondBindingCalls = 0;
	const pending = runCode({
		program: ORPHAN_RESERVATION_PROGRAM,
		bindings: {
			global: "tools",
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
					return null;
				},
				second: async () => {
					secondBindingCalls += 1;
					return null;
				},
			},
		},
		timeoutMs: RUNTIME_TEST_TIMEOUT_MS,
		maxOrphanedBindings: ORPHAN_LIMIT,
	});

	await firstStarted.promise;
	await firstAbortObserved.promise;
	const returnedBeforeDrain = await settledWithinDrainObservation(pending);
	allowFirstToSettle.resolve();
	const outcome = await pending;

	assert.equal(returnedBeforeDrain, false);
	assert.equal(secondBindingCalls, 0);
	assert.deepEqual(outcome.error, { kind: "orphan-limit" });
});

test("runCode caps unresolved binding orphans across invocations", async () => {
	const firstStarted = deferred();
	const allowFirstToSettle = deferred();
	const first = runCode({
		program: "await tools.hang(null); return null;",
		bindings: {
			global: "tools",
			functions: {
				hang: async () => {
					firstStarted.resolve();
					await allowFirstToSettle.promise;
					return null;
				},
			},
		},
		timeoutMs: NEVER_SETTLING_TIMEOUT_MS,
		drainTimeoutMs: NEVER_SETTLING_DRAIN_TIMEOUT_MS,
		maxOrphanedBindings: ORPHAN_LIMIT,
	});
	await firstStarted.promise;
	assert.deepEqual((await first).error, { kind: "timeout" });

	let secondBindingCalls = 0;
	const second = await runCode({
		program: "await tools.echo(null); return null;",
		bindings: {
			global: "tools",
			functions: {
				echo: async () => {
					secondBindingCalls += 1;
					return null;
				},
			},
		},
		timeoutMs: RUNTIME_TEST_TIMEOUT_MS,
		maxOrphanedBindings: ORPHAN_LIMIT,
	});
	allowFirstToSettle.resolve();
	await nextTurn();

	assert.equal(secondBindingCalls, 0);
	assert.deepEqual(second.error, { kind: "orphan-limit" });
});

test("runCode terminates when serialized logs exceed the byte limit", async () => {
	const outcome = await runCode({
		program: 'console.log("12345"); return 1;',
		maxOutputBytes: 17,
		maxOutputLines: 2000,
	});
	assert.deepEqual(outcome, { logs: [], error: { kind: "output-limit" } });
});

test("runCode terminates when logs exceed the logical line limit", async () => {
	const outcome = await runCode({
		program: 'console.log("one"); console.log("two"); console.log("three"); return 1;',
		maxOutputBytes: 51200,
		maxOutputLines: 2,
	});
	assert.deepEqual(outcome, {
		logs: ["one", "two"],
		error: { kind: "output-limit" },
	});
});

test("runCode bounds worker failure bytes before host ingestion", async () => {
	const outcome = await runCode({
		program: `throw new Error(${JSON.stringify(OVERSIZED_WORKER_FAILURE_MESSAGE)});`,
		maxOutputBytes: WORKER_FAILURE_MAX_BYTES,
		maxOutputLines: SHIPPED_PTC_CONFIG.maxOutputLines,
	});

	assert.deepEqual(outcome, { logs: [], error: { kind: "output-limit" } });
});

test("runCode counts carriage-return worker failures as logical lines", async () => {
	const outcome = await runCode({
		program: `throw new Error(${JSON.stringify(CR_ONLY_WORKER_FAILURE_MESSAGE)});`,
		maxOutputBytes: SHIPPED_PTC_CONFIG.maxOutputBytes,
		maxOutputLines: WORKER_FAILURE_MAX_LINES,
	});

	assert.deepEqual(outcome, { logs: [], error: { kind: "output-limit" } });
});

test("runCode starts workers with an empty environment", async () => {
	const outcome = await runCode({ program: "return Object.keys(process.env);" });
	assert.deepEqual(outcome, { logs: [], result: [] });
});
