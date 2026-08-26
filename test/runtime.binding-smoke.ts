// Bun-only smoke covers worker lifecycle behavior Node cannot reproduce.

import { runCode } from "../src/runtime.ts";

const BINDING_SMOKE_TIMEOUT_MS = 1500;
const OUTPUT_LIMIT_BYTES = 17;
const OUTPUT_LIMIT_LINES = 2000;
const TERMINATION_SETTLE_MS = 100;

const started = Date.now();
const outcome = await runCode({
	program: "return await tools.echo({ n: 1 });",
	bindings: {
		global: "tools",
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
	JSON.stringify({ logs: [], error: { kind: "output-limit" } })
) {
	console.error(JSON.stringify({ outputLimitOutcome }));
	process.exit(1);
}

let rejectBinding: (() => void) | undefined;
let markBindingStarted: (() => void) | undefined;
const bindingStarted = new Promise<void>((resolve) => {
	markBindingStarted = resolve;
});
const controller = new AbortController();
const pendingAbort = runCode({
	program: "return await tools.slow(null);",
	bindings: {
		global: "tools",
		functions: {
			slow: () => {
				markBindingStarted?.();
				return new Promise<null>((_resolve, reject) => {
					rejectBinding = () => reject(new Error("late binding rejection"));
				});
			},
		},
	},
	signal: controller.signal,
	timeoutMs: BINDING_SMOKE_TIMEOUT_MS,
});
await bindingStarted;
controller.abort();
const abortOutcome = await pendingAbort;
const unhandledRejections: unknown[] = [];
process.on("unhandledRejection", (error) => {
	unhandledRejections.push(error);
});
await new Promise((resolve) => setTimeout(resolve, TERMINATION_SETTLE_MS));
rejectBinding?.();
await new Promise((resolve) => setImmediate(resolve));
if (unhandledRejections.length > 0) {
	console.error(unhandledRejections[0]);
	process.exit(1);
}
if (JSON.stringify(abortOutcome) !== JSON.stringify({ logs: [], error: { kind: "abort" } })) {
	console.error(JSON.stringify({ abortOutcome }));
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
	}),
);
