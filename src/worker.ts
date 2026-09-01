// Hostile peer: this file runs model-authored code. Trust only rebuilt host messages.

import { parentPort, workerData } from "node:worker_threads";

import { PROGRAM_WRAPPER_NAME } from "./config.ts";
import { type JsonValue, snapshotJsonValue } from "./json.ts";
import {
	type HostToWorker,
	logicalLineCount,
	WORKER_BINDING_NAME,
	type WorkerBootData,
} from "./worker-protocol.ts";

const BINDING_ARGUMENT_LIMIT_MESSAGE = "binding arguments exceed maxOutputBytes";
const EMPTY_FAILURE_MESSAGE = "";
const UTF8_ENCODING = "utf8";

class ToolResultDeliveryError extends Error {
	readonly executionSucceeded = true;
	readonly retryUnsafe = true;
	readonly toolName: string;

	constructor(toolName: string, message: string) {
		super(message);
		this.name = "ToolResultDeliveryError";
		this.toolName = toolName;
	}
}

class ToolCallError extends Error {
	readonly toolName: string;

	constructor(toolName: string, message: string) {
		super(message);
		this.name = "ToolCallError";
		this.toolName = toolName;
	}
}

const port = parentPort;
if (port === null) {
	throw new Error("ptc worker must run as a worker thread");
}

const boot = workerData as WorkerBootData;
const pending = new Map<
	number,
	{ resolve: (value: JsonValue) => void; reject: (error: Error) => void }
>();
let nextCallId = 1;

port.on("message", (raw: unknown) => {
	if (typeof raw !== "object" || raw === null) return;
	const message = raw as HostToWorker;
	if (
		(message.type !== "reply" && message.type !== "result-delivery") ||
		typeof message.id !== "number"
	) {
		return;
	}
	const waiter = pending.get(message.id);
	if (!waiter) return;
	pending.delete(message.id);
	if (message.type === "result-delivery") {
		waiter.reject(new ToolResultDeliveryError(message.toolName, message.message));
	} else if (message.ok) {
		waiter.resolve(message.value);
	} else {
		waiter.reject(new ToolCallError(message.toolName, message.message));
	}
});

function exceedsPayloadLimit(value: JsonValue): boolean {
	return Buffer.byteLength(JSON.stringify(value), UTF8_ENCODING) > boot.maxOutputBytes;
}

const bindings: Record<string, (args: JsonValue) => Promise<JsonValue>> = Object.create(null);
for (const name of boot.bindingNames) {
	bindings[name] = async (args: JsonValue) => {
		const id = nextCallId;
		nextCallId += 1;
		const snapshot = snapshotJsonValue(args);
		if (exceedsPayloadLimit(snapshot)) {
			throw new ToolCallError(name, BINDING_ARGUMENT_LIMIT_MESSAGE);
		}
		const result = new Promise<JsonValue>((resolve, reject) => {
			pending.set(id, { resolve, reject });
		});
		port.postMessage({ type: "call", id, name, args: snapshot });
		return await result;
	};
}

const consoleShim = {
	log: (...args: unknown[]) => emitLog(args),
	info: (...args: unknown[]) => emitLog(args),
	warn: (...args: unknown[]) => emitLog(args),
	error: (...args: unknown[]) => emitLog(args),
};

const emitLog = (args: unknown[]): void => {
	port.postMessage({ type: "log", text: args.map(String).join(" ") });
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
			const snapshot = snapshotJsonValue(value);
			if (exceedsPayloadLimit(snapshot)) {
				port.postMessage({ type: "fail", kind: "output-limit", message: EMPTY_FAILURE_MESSAGE });
				return;
			}
			port.postMessage({ type: "done", value: snapshot });
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (
			Buffer.byteLength(message, UTF8_ENCODING) > boot.maxOutputBytes ||
			logicalLineCount(message) > boot.maxOutputLines
		) {
			port.postMessage({
				type: "fail",
				kind: "output-limit",
				message: EMPTY_FAILURE_MESSAGE,
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
