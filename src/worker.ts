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
				snapshot.ok
					? { type: "done", value: snapshot.value }
					: {
							type: "fail",
							kind: "output-limit",
							message: outputLimit.describe(
								outputLimit.PROGRAM_RESULT_SUBJECT,
								outputLimit.MAX_OUTPUT_BYTES_NAME,
								snapshot.bytes,
								boot.maxOutputBytes,
							),
						},
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const messageBytes = Buffer.byteLength(message, UTF8_ENCODING);
		const messageLines = logicalLineCount(message);
		if (messageBytes > boot.maxOutputBytes) {
			port.postMessage({
				type: "fail",
				kind: "output-limit",
				message: outputLimit.describe(
					outputLimit.WORKER_ERROR_SUBJECT,
					outputLimit.MAX_OUTPUT_BYTES_NAME,
					messageBytes,
					boot.maxOutputBytes,
				),
			});
			return;
		}
		if (messageLines > boot.maxOutputLines) {
			port.postMessage({
				type: "fail",
				kind: "output-limit",
				message: outputLimit.describe(
					outputLimit.WORKER_ERROR_SUBJECT,
					outputLimit.MAX_OUTPUT_LINES_NAME,
					messageLines,
					boot.maxOutputLines,
				),
			});
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
