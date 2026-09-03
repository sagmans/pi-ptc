// Hostile peer: this file runs model-authored code. Trust only rebuilt host messages.

import { parentPort, workerData } from "node:worker_threads";
import { createArtifactFunction } from "./artifacts.ts";
import { PROGRAM_WRAPPER_NAME } from "./config.ts";
import { createWorkerBindings, ToolCallError, ToolResultDeliveryError } from "./worker-bindings.ts";
import { postWorkerFailure } from "./worker-failure.ts";
import { WORKER_BINDING_NAME, type WorkerBootData } from "./worker-protocol.ts";
import { completeWorkerResult } from "./worker-result.ts";

const port = parentPort;
if (port === null) throw new Error("ptc worker must run as a worker thread");
const boot = workerData as WorkerBootData;
const bindings = createWorkerBindings(port, boot);

const emitLog = (args: unknown[]): void => {
	port.postMessage({ type: "log", text: args.map(String).join(" ") });
};
const consoleShim = {
	log: (...args: unknown[]) => emitLog(args),
	info: (...args: unknown[]) => emitLog(args),
	warn: (...args: unknown[]) => emitLog(args),
	error: (...args: unknown[]) => emitLog(args),
};

// Bun does not pump worker parentPort replies during top-level await.
void (async () => {
	let program: (
		tools: unknown,
		toolCallError: unknown,
		toolResultDeliveryError: unknown,
		console: unknown,
		artifact: unknown,
	) => Promise<unknown>;
	try {
		const create = new Function(
			`${boot.program}\nreturn ${PROGRAM_WRAPPER_NAME};`,
		) as () => typeof program;
		program = create();
	} catch (error) {
		postWorkerFailure(port, boot, error, "program-compile");
		return;
	}

	try {
		const workerGlobals = { [WORKER_BINDING_NAME]: bindings };
		const value = await program(
			workerGlobals[WORKER_BINDING_NAME],
			ToolCallError,
			ToolResultDeliveryError,
			consoleShim,
			createArtifactFunction(boot.artifacts),
		);
		if (value === undefined) {
			port.postMessage({ type: "done" });
			return;
		}
		await completeWorkerResult(port, boot, value);
	} catch (error) {
		postWorkerFailure(port, boot, error);
	}
})();
