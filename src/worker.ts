// Hostile peer: this file runs model-authored code. Trust only rebuilt host messages.

import { parentPort, workerData } from "node:worker_threads";

import { PROGRAM_WRAPPER_NAME } from "./config.ts";
import * as outputLimit from "./output-limit.ts";
import { logicalJsonLineCount } from "./output-measure.ts";
import {
	createWorkerBindings,
	snapshotWorkerPayload,
	ToolCallError,
	ToolResultDeliveryError,
} from "./worker-bindings.ts";
import { postWorkerFailure, postWorkerOutputLimit } from "./worker-failure.ts";
import { WORKER_BINDING_NAME, type WorkerBootData } from "./worker-protocol.ts";

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
		);
		if (value === undefined) {
			port.postMessage({ type: "done" });
			return;
		}
		let snapshot: ReturnType<typeof snapshotWorkerPayload>;
		try {
			snapshot = snapshotWorkerPayload(value, boot.maxOutputBytes);
		} catch (error) {
			postWorkerFailure(port, boot, error, "program-result-json");
			return;
		}
		if (snapshot.ok) {
			// Semantic lines are counted before posting so JSON escaping inside
			// string leaves cannot bypass the configured line bound.
			const resultLines = logicalJsonLineCount(snapshot.value);
			if (resultLines > boot.maxOutputLines) {
				postWorkerOutputLimit(
					port,
					outputLimit.PROGRAM_RESULT_SUBJECT,
					outputLimit.MAX_OUTPUT_LINES_NAME,
					resultLines,
					boot.maxOutputLines,
				);
				return;
			}
			port.postMessage({ type: "done", value: snapshot.value });
			return;
		}
		postWorkerOutputLimit(
			port,
			outputLimit.PROGRAM_RESULT_SUBJECT,
			outputLimit.MAX_OUTPUT_BYTES_NAME,
			snapshot.bytes,
			boot.maxOutputBytes,
		);
	} catch (error) {
		postWorkerFailure(port, boot, error);
	}
})();
