import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SHIPPED_PTC_CONFIG } from "../src/config.ts";
import { runCode } from "../src/runtime.ts";

const ACTIVE_BINDING_TIMEOUT_MS = 1500;
const RUNTIME_TEST_TIMEOUT_MS = 1500;
const NEVER_SETTLING_TIMEOUT_MS = 100;
const NEVER_SETTLING_DRAIN_TIMEOUT_MS = 30;
const NEVER_SETTLING_TEST_TIMEOUT_MS = 500;
const WORKER_TERMINATION_TIMEOUT_MS = 100;
const WORKER_TERMINATION_DRAIN_TIMEOUT_MS = 300;
const LATE_WORKER_ACTIVITY_DELAY_MS = 150;
const WORKER_TERMINATION_TEST_TIMEOUT_MS = 1000;
const ORPHAN_LIMIT = 1;
const WORKER_FAILURE_MAX_BYTES = 64;
const WORKER_FAILURE_MAX_LINES = 2;
const OVERSIZED_WORKER_FAILURE_MESSAGE = "failure".repeat(WORKER_FAILURE_MAX_BYTES + 1);
const CR_ONLY_WORKER_FAILURE_MESSAGE = "one\rtwo\rthree";
const DRAIN_OBSERVATION_MS = 500;
const EXCESS_BINDING_CALLS = SHIPPED_PTC_CONFIG.maxDispatches + 1;
const LATE_BINDING_ERROR = "late binding rejection";
const FIRST_WORKER_CALL_ID = 1;
const OUT_OF_ORDER_WORKER_CALL_ID = 2;
const UNSAFE_WORKER_CALL_ID = Number.MAX_SAFE_INTEGER + 1;
const HOSTILE_BINDING_NAME = "echo";
const INVALID_WORKER_CALL_ID_CASES = [
	{ name: "zero", ids: [0], expectedBindingCalls: 0 },
	{ name: "unsafe", ids: [UNSAFE_WORKER_CALL_ID], expectedBindingCalls: 0 },
	{
		name: "decreasing",
		ids: [OUT_OF_ORDER_WORKER_CALL_ID, FIRST_WORKER_CALL_ID],
		expectedBindingCalls: 1,
	},
] as const;
const MALFORMED_WORKER_MESSAGES = [
	{ type: "call", id: "1", name: HOSTILE_BINDING_NAME, args: null },
	{ type: "call", id: FIRST_WORKER_CALL_ID, name: 1, args: null },
	{ type: "call", id: FIRST_WORKER_CALL_ID, name: HOSTILE_BINDING_NAME },
	{ type: "fail", kind: "unknown", message: "bad failure kind" },
	{ type: "unknown" },
] as const;
const ACTIVE_BINDING_CALL_LIMIT = 1;
const ACTIVE_LIMIT_PROGRAM = "void tools.first(null); void tools.second(null); return null;";
const ORPHAN_RESERVATION_PROGRAM =
	"void tools.first(null); void tools.second(null); await new Promise(() => undefined);";

function deferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

async function nextTurn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function settledWithinDrainObservation(promise: Promise<unknown>): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		let observationEnded = false;
		const timer = setTimeout(() => {
			observationEnded = true;
			resolve(false);
		}, DRAIN_OBSERVATION_MS);
		void promise.then(
			() => {
				if (observationEnded) return;
				clearTimeout(timer);
				resolve(true);
			},
			() => {
				if (observationEnded) return;
				clearTimeout(timer);
				resolve(true);
			},
		);
	});
}

function hostileWorkerCallsProgram(ids: readonly number[]): string {
	return `
const { parentPort } = await import("node:worker_threads");
for (const id of ${JSON.stringify(ids)}) {
  parentPort.postMessage({ type: "call", id, name: "${HOSTILE_BINDING_NAME}", args: id });
}
return null;
`;
}

function hostileWorkerMessageProgram(message: unknown): string {
	return `
const { parentPort } = await import("node:worker_threads");
parentPort.postMessage(${JSON.stringify(message)});
return null;
`;
}

test("runCode returns the program completion value", async () => {
	const outcome = await runCode({ program: "return 1 + 1;" });
	assert.deepEqual(outcome, { logs: [], result: 2 });
});

test("runCode captures console output and a null result", async () => {
	const outcome = await runCode({
		program: 'console.log("x"); return null;',
	});
	assert.deepEqual(outcome, { logs: ["x"], result: null });
});

test("runCode omits result when the program returns undefined", async () => {
	const outcome = await runCode({ program: "return;" });
	assert.deepEqual(outcome, { logs: [] });
});

test("runCode reports a thrown program error", async () => {
	const outcome = await runCode({ program: 'throw new Error("boom");' });
	assert.deepEqual(outcome.error, { kind: "throw", message: "boom" });
});

test("runCode calls host bindings and returns their JSON value", async () => {
	const outcome = await runCode({
		program: "return await tools.echo({ n: 3 });",
		bindings: {
			global: "tools",
			functions: {
				echo: async (args) => args,
			},
		},
		timeoutMs: 1500,
	});
	assert.deepEqual(outcome, { logs: [], result: { n: 3 } });
});

test("runCode rejects binding failures as ToolCallError", async () => {
	const outcome = await runCode({
		program: `
try {
  await tools.fail({ x: 1 });
  return "nope";
} catch (error) {
  return {
    name: error.name,
    toolName: error.toolName,
    isToolCallError: error instanceof ToolCallError,
    message: error.message,
  };
}
`,
		bindings: {
			global: "tools",
			functions: {
				fail: async () => {
					throw Object.assign(new Error("denied"), { toolName: "fail" });
				},
			},
		},
	});
	assert.deepEqual(outcome, {
		logs: [],
		result: {
			name: "ToolCallError",
			toolName: "fail",
			isToolCallError: true,
			message: "denied",
		},
	});
});

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
				global: "tools",
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
			global: "tools",
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

test("runCode aborts an active binding signal on timeout", async () => {
	let bindingStarted = false;
	let bindingSignal: AbortSignal | undefined;
	let bindingSettled = false;
	const outcome = await runCode({
		program: "await tools.hang(null); return 1;",
		bindings: {
			global: "tools",
			functions: {
				hang: async (_args, signal) => {
					bindingStarted = true;
					bindingSignal = signal;
					await new Promise<void>((resolve) => {
						signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					bindingSettled = true;
					return null;
				},
			},
		},
		timeoutMs: ACTIVE_BINDING_TIMEOUT_MS,
	});
	assert.deepEqual(outcome.error, { kind: "timeout" });
	assert.equal(bindingStarted, true);
	assert.equal(bindingSignal?.aborted, true);
	assert.equal(bindingSettled, true);
});

test("runCode returns after the drain deadline when a timed-out binding never settles", {
	timeout: NEVER_SETTLING_TEST_TIMEOUT_MS,
}, async () => {
	const bindingStarted = deferred();
	const allowBindingToSettle = deferred();
	const pending = runCode({
		program: "await tools.hang(null); return 1;",
		bindings: {
			global: "tools",
			functions: {
				hang: async () => {
					bindingStarted.resolve();
					await allowBindingToSettle.promise;
					return null;
				},
			},
		},
		timeoutMs: NEVER_SETTLING_TIMEOUT_MS,
		drainTimeoutMs: NEVER_SETTLING_DRAIN_TIMEOUT_MS,
	});
	await bindingStarted.promise;

	const outcome = await pending;
	allowBindingToSettle.resolve();
	await nextTurn();

	assert.deepEqual(outcome.error, { kind: "timeout" });
});

test("runCode returns after the drain deadline when an aborted binding never settles", {
	timeout: NEVER_SETTLING_TEST_TIMEOUT_MS,
}, async () => {
	const controller = new AbortController();
	const bindingStarted = deferred();
	const allowBindingToSettle = deferred();
	const pending = runCode({
		program: "await tools.hang(null); return 1;",
		bindings: {
			global: "tools",
			functions: {
				hang: async () => {
					bindingStarted.resolve();
					await allowBindingToSettle.promise;
					return null;
				},
			},
		},
		signal: controller.signal,
		timeoutMs: RUNTIME_TEST_TIMEOUT_MS,
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
				global: "tools",
				functions: {
					hang: async () => {
						bindingStarted.resolve();
						await allowBindingToSettle.promise;
						return null;
					},
				},
			},
			timeoutMs: WORKER_TERMINATION_TIMEOUT_MS,
			drainTimeoutMs: WORKER_TERMINATION_DRAIN_TIMEOUT_MS,
		});
		await bindingStarted.promise;
		const outcome = await pending;
		assert.deepEqual(outcome.error, { kind: "timeout" });
		assert.equal(existsSync(markerPath), false);
	} finally {
		allowBindingToSettle.resolve();
		rmSync(directory, { recursive: true, force: true });
	}
});

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

test("runCode waits for an abort-aware binding after outer abort", async () => {
	const controller = new AbortController();
	const bindingStarted = deferred();
	const bindingAbortObserved = deferred();
	const allowBindingToSettle = deferred();
	let bindingSettled = false;
	const pending = runCode({
		program: "await tools.hang(null); return 1;",
		bindings: {
			global: "tools",
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
		timeoutMs: RUNTIME_TEST_TIMEOUT_MS,
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
			global: "tools",
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
		timeoutMs: RUNTIME_TEST_TIMEOUT_MS,
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
			global: "tools",
			functions: {
				echo: async (args) => {
					bindingCalls += 1;
					return args;
				},
			},
		},
		timeoutMs: RUNTIME_TEST_TIMEOUT_MS,
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
		timeoutMs: RUNTIME_TEST_TIMEOUT_MS,
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
				global: "tools",
				functions: {
					late: (_args, _signal) => {
						bindingStarted.resolve();
						return new Promise<never>((_resolve, reject) => {
							rejectBinding = reject;
						});
					},
				},
			},
			timeoutMs: RUNTIME_TEST_TIMEOUT_MS,
		});
		await bindingStarted.promise;
		await nextTurn();
		rejectBinding(new Error(LATE_BINDING_ERROR));
		const outcome = await pending;
		await nextTurn();

		assert.deepEqual(outcome.error, { kind: "dangling-dispatch" });
		assert.deepEqual(unhandledRejections, []);
	} finally {
		process.removeListener("unhandledRejection", onUnhandledRejection);
	}
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
