// Hostile peer: this file runs model-authored code. Trust only rebuilt host messages.

import { parentPort, workerData } from "node:worker_threads";

import { PROGRAM_WRAPPER_NAME } from "./config.ts";
import {
	createWorkerBindings,
	snapshotWorkerPayload,
	ToolCallError,
	ToolResultDeliveryError,
} from "./worker-bindings.ts";
import { logicalLineCount, WORKER_BINDING_NAME, type WorkerBootData } from "./worker-protocol.ts";

const EMPTY_FAILURE_MESSAGE = "";
const UTF8_ENCODING = "utf8";
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
	try {
		const create = new Function(`${boot.program}\nreturn ${PROGRAM_WRAPPER_NAME};`) as () => (
			tools: unknown,
			toolCallError: unknown,
			console: unknown,
		) => Promise<unknown>;
		const workerGlobals = { [WORKER_BINDING_NAME]: bindings };
		const value = await create()(workerGlobals[WORKER_BINDING_NAME], ToolCallError, consoleShim);
		if (value === undefined) {
			port.postMessage({ type: "done" });
		} else {
			const snapshot = snapshotWorkerPayload(value, boot.maxOutputBytes);
			port.postMessage(
				snapshot === undefined
					? { type: "fail", kind: "output-limit", message: EMPTY_FAILURE_MESSAGE }
					: { type: "done", value: snapshot },
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (
			Buffer.byteLength(message, UTF8_ENCODING) > boot.maxOutputBytes ||
			logicalLineCount(message) > boot.maxOutputLines
		) {
			port.postMessage({ type: "fail", kind: "output-limit", message: EMPTY_FAILURE_MESSAGE });
			return;
		}
		const kind =
			error instanceof ToolResultDeliveryError
				? "result-delivery"
				: message.includes("lossless JSON")
					? "invalid-output"
					: "throw";
		port.postMessage({ type: "fail", kind, message });
	}
})();
