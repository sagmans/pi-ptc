// Hostile peer: this file runs model-authored code. Trust only rebuilt host messages.

import { parentPort, workerData } from "node:worker_threads";

import { PROGRAM_WRAPPER_NAME } from "./config.ts";
import { type JsonValue, snapshotJsonValue } from "./json.ts";

type BootData = {
	program: string;
	bindingNames: string[];
};

type ReplyMessage =
	| { type: "reply"; id: number; ok: true; value: JsonValue }
	| { type: "reply"; id: number; ok: false; toolName: string; message: string };

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

const boot = workerData as BootData;
const pending = new Map<
	number,
	{ resolve: (value: JsonValue) => void; reject: (error: Error) => void }
>();
let nextCallId = 1;

port.on("message", (raw: unknown) => {
	if (typeof raw !== "object" || raw === null) return;
	const message = raw as ReplyMessage;
	if (message.type !== "reply" || typeof message.id !== "number") return;
	const waiter = pending.get(message.id);
	if (!waiter) return;
	pending.delete(message.id);
	if (message.ok) waiter.resolve(message.value);
	else waiter.reject(new ToolCallError(message.toolName, message.message));
});

const tools: Record<string, (args: JsonValue) => Promise<JsonValue>> = Object.create(null);
for (const name of boot.bindingNames) {
	tools[name] = async (args: JsonValue) => {
		const id = nextCallId;
		nextCallId += 1;
		const snapshot = snapshotJsonValue(args);
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

try {
	const create = new Function(`${boot.program}\nreturn ${PROGRAM_WRAPPER_NAME};`) as () => (
		tools: unknown,
		toolCallError: unknown,
		console: unknown,
	) => Promise<unknown>;
	const value = await create()(tools, ToolCallError, consoleShim);
	if (value === undefined) {
		port.postMessage({ type: "done" });
	} else {
		port.postMessage({ type: "done", value: snapshotJsonValue(value) });
	}
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	const kind = message.includes("lossless JSON") ? "invalid-output" : "throw";
	port.postMessage({ type: "fail", kind, message });
}
