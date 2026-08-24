// Bun-only smoke. Node's runtime tests stay green; this file catches the TLA deadlock.

import { runCode } from "../src/runtime.ts";

const BINDING_SMOKE_TIMEOUT_MS = 1500;

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
console.log(JSON.stringify({ ok: true, elapsedMs, outcome }));
