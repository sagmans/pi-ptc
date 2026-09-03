// Host-side code runtime. The worker is a containment isolate, not a sandbox.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { PROGRAM_WRAPPER_NAME, SHIPPED_PTC_CONFIG } from "./config.ts";
import type { CodeRunRequest, CodeRunResult } from "./runtime-contract.ts";
import { stripProgram } from "./strip.ts";
import { runWorkerSession } from "./worker-session.ts";

export { logicalTextLineCount as logicalLineCount } from "./output-measure.ts";
export type {
	BindingFn,
	CodeRunFailure,
	CodeRunRequest,
	CodeRunResult,
} from "./runtime-contract.ts";

const COMPILED_WORKER_PATH = fileURLToPath(new URL("../worker-dist/worker.js", import.meta.url));
const SOURCE_WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));
const WORKER_PATH = existsSync(COMPILED_WORKER_PATH) ? COMPILED_WORKER_PATH : SOURCE_WORKER_PATH;

export async function runCode(request: CodeRunRequest): Promise<CodeRunResult> {
	let program: string;
	try {
		// Strip a function wrapper so top-level return/await stay legal.
		program = stripProgram(
			`async function ${PROGRAM_WRAPPER_NAME}(tools, ToolCallError, ToolResultDeliveryError, console) {
${request.program}
}`,
		);
	} catch (error) {
		return {
			logs: [],
			error: {
				kind: "program-transform",
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}

	const functions = request.bindings?.functions ?? {};
	const timeoutMs = request.timeoutMs ?? SHIPPED_PTC_CONFIG.timeoutMs;
	const drainTimeoutMs = request.drainTimeoutMs ?? SHIPPED_PTC_CONFIG.drainTimeoutMs;
	const maxOutputBytes = request.maxOutputBytes ?? SHIPPED_PTC_CONFIG.maxOutputBytes;
	const maxOutputLines = request.maxOutputLines ?? SHIPPED_PTC_CONFIG.maxOutputLines;
	const maxBindingCalls = request.maxBindingCalls ?? SHIPPED_PTC_CONFIG.maxDispatches;
	const worker = new Worker(WORKER_PATH, {
		env: {},
		resourceLimits: {
			maxOldGenerationSizeMb: SHIPPED_PTC_CONFIG.workerMaxOldGenerationSizeMb,
		},
		workerData: {
			program,
			bindingNames: Object.keys(functions),
			maxOutputBytes,
			maxOutputLines,
		},
	});

	return await runWorkerSession({
		worker,
		request,
		functions,
		timeoutMs,
		drainTimeoutMs,
		maxOutputBytes,
		maxOutputLines,
		maxBindingCalls,
	});
}
