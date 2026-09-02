import { SHIPPED_PTC_CONFIG } from "../../src/config.ts";

export const ACTIVE_BINDING_TIMEOUT_MS = 1500;
export const RUNTIME_TEST_TIMEOUT_MS = 1500;
export const NEVER_SETTLING_DRAIN_TIMEOUT_MS = 30;
export const NEVER_SETTLING_TEST_TIMEOUT_MS = RUNTIME_TEST_TIMEOUT_MS * 2;
export const WORKER_TERMINATION_DRAIN_TIMEOUT_MS = 300;
export const LATE_WORKER_ACTIVITY_DELAY_MS = 150;
export const WORKER_TERMINATION_TEST_TIMEOUT_MS = RUNTIME_TEST_TIMEOUT_MS * 2;
export const ORPHAN_LIMIT = 1;
export const WORKER_FAILURE_MAX_BYTES = 64;
export const WORKER_FAILURE_MAX_LINES = 2;
export const OVERSIZED_WORKER_FAILURE_MESSAGE = "failure".repeat(WORKER_FAILURE_MAX_BYTES + 1);
export const CR_ONLY_WORKER_FAILURE_MESSAGE = "one\rtwo\rthree";
export const DRAIN_OBSERVATION_MS = 500;
export const EXCESS_BINDING_CALLS = SHIPPED_PTC_CONFIG.maxDispatches + 1;
export const LATE_BINDING_ERROR = "late binding rejection";
export const FIRST_WORKER_CALL_ID = 1;
export const OUT_OF_ORDER_WORKER_CALL_ID = 2;
export const UNSAFE_WORKER_CALL_ID = Number.MAX_SAFE_INTEGER + 1;
export const HOSTILE_BINDING_NAME = "echo";
export const INVALID_WORKER_CALL_ID_CASES = [
	{ name: "zero", ids: [0], expectedBindingCalls: 0 },
	{ name: "unsafe", ids: [UNSAFE_WORKER_CALL_ID], expectedBindingCalls: 0 },
	{
		name: "decreasing",
		ids: [OUT_OF_ORDER_WORKER_CALL_ID, FIRST_WORKER_CALL_ID],
		expectedBindingCalls: 1,
	},
] as const;
export const MALFORMED_WORKER_MESSAGES = [
	{ type: "call", id: "1", name: HOSTILE_BINDING_NAME, args: null },
	{ type: "call", id: FIRST_WORKER_CALL_ID, name: 1, args: null },
	{ type: "call", id: FIRST_WORKER_CALL_ID, name: HOSTILE_BINDING_NAME },
	{ type: "fail", kind: "unknown", message: "bad failure kind" },
	{ type: "unknown" },
] as const;
export const ACTIVE_BINDING_CALL_LIMIT = 1;
export const ACTIVE_LIMIT_PROGRAM = "void tools.first(null); void tools.second(null); return null;";
export const ORPHAN_RESERVATION_PROGRAM =
	"void tools.first(null); void tools.second(null); await new Promise(() => undefined);";

export function deferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

export async function nextTurn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

export async function settledWithinDrainObservation(promise: Promise<unknown>): Promise<boolean> {
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

export function hostileWorkerCallsProgram(ids: readonly number[]): string {
	return `
const { parentPort } = await import("node:worker_threads");
for (const id of ${JSON.stringify(ids)}) {
  parentPort.postMessage({ type: "call", id, name: "${HOSTILE_BINDING_NAME}", args: id });
}
return null;
`;
}

export function hostileWorkerMessageProgram(message: unknown): string {
	return `
const { parentPort } = await import("node:worker_threads");
parentPort.postMessage(${JSON.stringify(message)});
return null;
`;
}
