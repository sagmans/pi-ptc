import { strict as assert } from "node:assert";
import test from "node:test";

import { SHIPPED_PTC_CONFIG } from "../src/config.ts";
import {
	createOrphanBindingGovernor,
	type OrphanBindingReservation,
	processOrphanBindingGovernor,
	resolveProcessOrphanBindingGovernor,
} from "../src/orphan-binding-governor.ts";
import { runCode } from "../src/runtime.ts";
import {
	CR_ONLY_WORKER_FAILURE_MESSAGE,
	deferred,
	NEVER_SETTLING_DRAIN_TIMEOUT_MS,
	NEVER_SETTLING_TIMEOUT_MS,
	nextTurn,
	ORPHAN_RESERVATION_PROGRAM,
	OVERSIZED_WORKER_FAILURE_MESSAGE,
	RUNTIME_TEST_TIMEOUT_MS,
	settledWithinDrainObservation,
	WORKER_FAILURE_MAX_BYTES,
	WORKER_FAILURE_MAX_LINES,
} from "./support/runtime-harness.ts";

const PROGRAM_RESULT_LIMIT_MESSAGE = "program result exceeds maxOutputBytes: 258 > 128";
const LOG_BYTE_LIMIT_MESSAGE = "log output exceeds maxOutputBytes: 18 > 17";
const LOG_LINE_LIMIT_MESSAGE = "log output exceeds maxOutputLines: 3 > 2";
const WORKER_ERROR_BYTE_LIMIT_MESSAGE = "worker error message exceeds maxOutputBytes: 455 > 64";
const WORKER_ERROR_LINE_LIMIT_MESSAGE = "worker error message exceeds maxOutputLines: 3 > 2";
const MULTILINE_FAILURE_BYTES = 1_000_000;
const MULTILINE_WORKER_ERROR_LIMIT_MESSAGE = `worker error message exceeds maxOutputBytes: ${MULTILINE_FAILURE_BYTES} > ${WORKER_FAILURE_MAX_BYTES}`;

function reserveAllButOneOrphanSlot(): OrphanBindingReservation[] {
	const reservations: OrphanBindingReservation[] = [];
	for (let index = 1; index < SHIPPED_PTC_CONFIG.maxOrphanedBindings; index += 1) {
		const reservation = processOrphanBindingGovernor.acquire();
		assert.ok(reservation);
		reservations.push(reservation);
	}
	return reservations;
}

function releaseReservations(reservations: readonly OrphanBindingReservation[]): void {
	for (const reservation of reservations) reservation.release();
}

test("orphan governor owns one fixed ceiling and idempotent release", () => {
	const governor = createOrphanBindingGovernor(1);
	const reservation = governor.acquire();
	assert.ok(reservation);
	assert.equal(governor.active, 1);
	assert.equal(governor.acquire(), undefined);
	reservation.release();
	reservation.release();
	assert.equal(governor.active, 0);
	assert.ok(governor.acquire());
});

test("physical module copies resolve one conservative process governor", () => {
	const sharedGlobal = {};
	const first = resolveProcessOrphanBindingGovernor(sharedGlobal, 2);
	const second = resolveProcessOrphanBindingGovernor(sharedGlobal, 1);
	const reservation = first.acquire();
	assert.ok(reservation);
	assert.equal(second.active, 1);
	assert.equal(second.acquire(), undefined);
	reservation.release();
	assert.equal(first.active, 0);
	const secondReservation = second.acquire();
	assert.ok(secondReservation);
	secondReservation.release();
});

test("runCode reserves orphan capacity before parallel bindings start", async () => {
	const firstStarted = deferred();
	const firstAbortObserved = deferred();
	const allowFirstToSettle = deferred();
	let secondBindingCalls = 0;
	const reservations = reserveAllButOneOrphanSlot();
	const pending = runCode({
		program: ORPHAN_RESERVATION_PROGRAM,
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
					return null;
				},
				second: async () => {
					secondBindingCalls += 1;
					return null;
				},
			},
		},
		timeoutMs: RUNTIME_TEST_TIMEOUT_MS,
	});

	await firstStarted.promise;
	await firstAbortObserved.promise;
	const returnedBeforeDrain = await settledWithinDrainObservation(pending);
	allowFirstToSettle.resolve();
	const outcome = await pending;

	assert.equal(returnedBeforeDrain, false);
	assert.equal(secondBindingCalls, 0);
	assert.deepEqual(outcome.error, { kind: "orphan-limit" });
	releaseReservations(reservations);
});

test("runCode caps unresolved binding orphans across invocations", async () => {
	const reservations = reserveAllButOneOrphanSlot();
	const firstStarted = deferred();
	const allowFirstToSettle = deferred();
	const first = runCode({
		program: "await tools.hang(null); return null;",
		bindings: {
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
	});
	await firstStarted.promise;
	assert.deepEqual((await first).error, { kind: "timeout" });

	let secondBindingCalls = 0;
	const second = await runCode({
		program: "await tools.echo(null); return null;",
		bindings: {
			functions: {
				echo: async () => {
					secondBindingCalls += 1;
					return null;
				},
			},
		},
		timeoutMs: RUNTIME_TEST_TIMEOUT_MS,
	});
	allowFirstToSettle.resolve();
	await nextTurn();

	assert.equal(secondBindingCalls, 0);
	assert.deepEqual(second.error, { kind: "orphan-limit" });
	releaseReservations(reservations);
});

test("worker rejects oversized binding arguments before host execution", async () => {
	let bindingCalls = 0;
	const outcome = await runCode({
		program:
			'try { await tools.echo({ value: "x".repeat(256) }); } catch (error) { return { name: error.name, message: error.message }; }',
		bindings: {
			functions: {
				async echo() {
					bindingCalls += 1;
					return null;
				},
			},
		},
		maxOutputBytes: 128,
	});
	assert.equal(bindingCalls, 0);
	assert.deepEqual(outcome, {
		logs: [],
		result: {
			name: "ToolCallError",
			message: "binding arguments exceed maxOutputBytes",
		},
	});
});

test("worker rejects oversized outer values before host delivery", async () => {
	const outcome = await runCode({
		program: 'return "x".repeat(256);',
		maxOutputBytes: 128,
	});
	assert.deepEqual(outcome, {
		logs: [],
		error: { kind: "output-limit", message: PROGRAM_RESULT_LIMIT_MESSAGE },
	});
});

test("runCode terminates when serialized logs exceed the byte limit", async () => {
	const outcome = await runCode({
		program: 'console.log("12345"); return 1;',
		maxOutputBytes: 17,
		maxOutputLines: 2000,
	});
	assert.deepEqual(outcome, {
		logs: [],
		error: { kind: "output-limit", message: LOG_BYTE_LIMIT_MESSAGE },
	});
});

test("runCode terminates when logs exceed the logical line limit", async () => {
	const outcome = await runCode({
		program: 'console.log("one"); console.log("two"); console.log("three"); return 1;',
		maxOutputBytes: 51200,
		maxOutputLines: 2,
	});
	assert.deepEqual(outcome, {
		logs: ["one", "two"],
		error: { kind: "output-limit", message: LOG_LINE_LIMIT_MESSAGE },
	});
});

test("runCode bounds worker failure bytes before host ingestion", async () => {
	const outcome = await runCode({
		program: `throw new Error(${JSON.stringify(OVERSIZED_WORKER_FAILURE_MESSAGE)});`,
		maxOutputBytes: WORKER_FAILURE_MAX_BYTES,
		maxOutputLines: SHIPPED_PTC_CONFIG.maxOutputLines,
	});

	assert.deepEqual(outcome, {
		logs: [],
		error: { kind: "output-limit", message: WORKER_ERROR_BYTE_LIMIT_MESSAGE },
	});
});

test("worker byte-bounds newline-rich errors before counting lines", async () => {
	const outcome = await runCode({
		program: `throw new Error("\\n".repeat(${MULTILINE_FAILURE_BYTES}));`,
		maxOutputBytes: WORKER_FAILURE_MAX_BYTES,
		maxOutputLines: SHIPPED_PTC_CONFIG.maxOutputLines,
	});

	assert.deepEqual(outcome, {
		logs: [],
		error: { kind: "output-limit", message: MULTILINE_WORKER_ERROR_LIMIT_MESSAGE },
	});
});

test("runCode counts carriage-return worker failures as logical lines", async () => {
	const outcome = await runCode({
		program: `throw new Error(${JSON.stringify(CR_ONLY_WORKER_FAILURE_MESSAGE)});`,
		maxOutputBytes: SHIPPED_PTC_CONFIG.maxOutputBytes,
		maxOutputLines: WORKER_FAILURE_MAX_LINES,
	});

	assert.deepEqual(outcome, {
		logs: [],
		error: { kind: "output-limit", message: WORKER_ERROR_LINE_LIMIT_MESSAGE },
	});
});

test("runCode starts workers with an empty environment", async () => {
	const outcome = await runCode({ program: "return Object.keys(process.env);" });
	assert.deepEqual(outcome, { logs: [], result: [] });
});
