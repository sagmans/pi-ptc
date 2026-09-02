// Hostile peer: this file runs model-authored code. Trust only rebuilt host messages.

import { parentPort, workerData } from "node:worker_threads";

import { PROGRAM_WRAPPER_NAME } from "./config.ts";
import * as outputLimit from "./output-limit.ts";
import {
	createWorkerBindings,
	snapshotWorkerPayload,
	ToolCallError,
	ToolResultDeliveryError,
} from "./worker-bindings.ts";
import { logicalLineCount, WORKER_BINDING_NAME, type WorkerBootData } from "./worker-protocol.ts";

const UTF8_ENCODING = "utf8";
const port = parentPort;
if (port === null) throw new Error("ptc worker must run as a worker thread");
const boot = workerData as WorkerBootData;
const bindings = createWorkerBindings(port, boot);

const postOutputLimit = (
	subject: outputLimit.OutputLimitSubject,
	limitName: outputLimit.OutputLimitName,
	observed: number,
	limit: number,
): void => {
	port.postMessage({ type: "fail", kind: "output-limit", subject, limitName, observed, limit });
};

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
		const create = new Function(`${boot.program}\nreturn ${PROGRAM_WRAPPER_NAME};`) as () => typeof program;
		program = create();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		port.postMessage({ type: "fail", kind: "program-compile", message });
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
		} else {
			const snapshot = snapshotWorkerPayload(value, boot.maxOutputBytes);
			if (snapshot.ok) {
				port.postMessage({ type: "done", value: snapshot.value });
			} else {
				postOutputLimit(
					outputLimit.PROGRAM_RESULT_SUBJECT,
					outputLimit.MAX_OUTPUT_BYTES_NAME,
					snapshot.bytes,
					boot.maxOutputBytes,
				);
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const messageBytes = Buffer.byteLength(message, UTF8_ENCODING);
		if (messageBytes > boot.maxOutputBytes) {
			postOutputLimit(
				outputLimit.WORKER_ERROR_SUBJECT,
				outputLimit.MAX_OUTPUT_BYTES_NAME,
				messageBytes,
				boot.maxOutputBytes,
			);
			return;
		}
		const messageLines = logicalLineCount(message);
		if (messageLines > boot.maxOutputLines) {
			postOutputLimit(
				outputLimit.WORKER_ERROR_SUBJECT,
				outputLimit.MAX_OUTPUT_LINES_NAME,
				messageLines,
				boot.maxOutputLines,
			);
			return;
		}
		const kind =
			error instanceof ToolResultDeliveryError
				? "result-delivery"
				: message.includes("lossless JSON")
					? "invalid-output"
					: "program-runtime";
		port.postMessage({ type: "fail", kind, message });
	}
})();
