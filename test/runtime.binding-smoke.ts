// Bun-only smoke covers worker lifecycle behavior Node cannot reproduce.

import { runCode } from "../src/runtime.ts";

const BINDING_SMOKE_TIMEOUT_MS = 1500;
const NEVER_SETTLING_DRAIN_TIMEOUT_MS = 30;
const OUTPUT_LIMIT_BYTES = 17;
const OUTPUT_LIMIT_LINES = 2000;
const OUTPUT_LIMIT_MESSAGE = "log output exceeds maxOutputBytes: 18 > 17";
const DRAIN_OBSERVATION_MS = 500;

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

const started = Date.now();
const outcome = await runCode({
	program: "return await tools.echo({ n: 1 });",
	bindings: {
		functions: {
			echo: async (args) => args,
		},
	},
	timeoutMs: BINDING_SMOKE_TIMEOUT_MS,
});

const elapsedMs = Date.now() - started;
if (outcome.error) {
	console.error(JSON.stringify({ elapsedMs, outcome }));
	process.exit(1);
}
if (JSON.stringify(outcome) !== JSON.stringify({ logs: [], result: { n: 1 } })) {
	console.error(JSON.stringify({ elapsedMs, outcome }));
	process.exit(1);
}

const environmentOutcome = await runCode({
	program: "return Object.keys(process.env);",
	timeoutMs: BINDING_SMOKE_TIMEOUT_MS,
});
if (JSON.stringify(environmentOutcome) !== JSON.stringify({ logs: [], result: [] })) {
	console.error(JSON.stringify({ environmentOutcome }));
	process.exit(1);
}

const outputLimitOutcome = await runCode({
	program: 'console.log("12345"); return 1;',
	timeoutMs: BINDING_SMOKE_TIMEOUT_MS,
	maxOutputBytes: OUTPUT_LIMIT_BYTES,
	maxOutputLines: OUTPUT_LIMIT_LINES,
});
if (
	JSON.stringify(outputLimitOutcome) !==
	JSON.stringify({ logs: [], error: { kind: "output-limit", message: OUTPUT_LIMIT_MESSAGE } })
) {
	console.error(JSON.stringify({ outputLimitOutcome }));
	process.exit(1);
}

let markBindingStarted: (() => void) | undefined;
let markBindingAbortObserved: (() => void) | undefined;
let allowBindingToSettle: (() => void) | undefined;
const bindingStarted = new Promise<void>((resolve) => {
	markBindingStarted = resolve;
});
const bindingAbortObserved = new Promise<void>((resolve) => {
	markBindingAbortObserved = resolve;
});
const bindingSettlementGate = new Promise<void>((resolve) => {
	allowBindingToSettle = resolve;
});
let bindingSettled = false;
const unhandledRejections: unknown[] = [];
const onUnhandledRejection = (error: unknown): void => {
	unhandledRejections.push(error);
};
process.on("unhandledRejection", onUnhandledRejection);
const controller = new AbortController();
const pendingAbort = runCode({
	program: "return await tools.slow(null);",
	bindings: {
		functions: {
			slow: async (_args, signal) => {
				markBindingStarted?.();
				if (!signal.aborted) {
					await new Promise<void>((resolve) => {
						signal.addEventListener("abort", () => resolve(), { once: true });
					});
				}
				markBindingAbortObserved?.();
				await bindingSettlementGate;
				bindingSettled = true;
				throw new Error("late binding rejection");
			},
		},
	},
	signal: controller.signal,
	timeoutMs: BINDING_SMOKE_TIMEOUT_MS,
});
await bindingStarted;
controller.abort();
await bindingAbortObserved;
const returnedBeforeDrain = await settledWithinDrainObservation(pendingAbort);
allowBindingToSettle?.();
const abortOutcome = await pendingAbort;
const bindingSettledBeforeReturn = bindingSettled;
await new Promise((resolve) => setImmediate(resolve));
process.removeListener("unhandledRejection", onUnhandledRejection);
if (unhandledRejections.length > 0) {
	console.error(unhandledRejections[0]);
	process.exit(1);
}
if (
	returnedBeforeDrain ||
	!bindingSettledBeforeReturn ||
	JSON.stringify(abortOutcome) !== JSON.stringify({ logs: [], error: { kind: "abort" } })
) {
	console.error(JSON.stringify({ abortOutcome, bindingSettledBeforeReturn, returnedBeforeDrain }));
	process.exit(1);
}

let markNeverSettlingStarted: (() => void) | undefined;
const neverSettlingStarted = new Promise<void>((resolve) => {
	markNeverSettlingStarted = resolve;
});
const pendingDrainDeadline = runCode({
	program: "return await tools.never(null);",
	bindings: {
		functions: {
			never: async () => {
				markNeverSettlingStarted?.();
				return await new Promise<never>(() => undefined);
			},
		},
	},
	timeoutMs: BINDING_SMOKE_TIMEOUT_MS,
	drainTimeoutMs: NEVER_SETTLING_DRAIN_TIMEOUT_MS,
});
await neverSettlingStarted;
const drainDeadlineOutcome = await pendingDrainDeadline;
if (
	JSON.stringify(drainDeadlineOutcome) !== JSON.stringify({ logs: [], error: { kind: "timeout" } })
) {
	console.error(JSON.stringify({ drainDeadlineOutcome }));
	process.exit(1);
}

console.log(
	JSON.stringify({
		ok: true,
		elapsedMs,
		outcome,
		environmentOutcome,
		outputLimitOutcome,
		abortOutcome,
		drainDeadlineOutcome,
		drainProof: { bindingSettledBeforeReturn, returnedBeforeDrain },
	}),
);
