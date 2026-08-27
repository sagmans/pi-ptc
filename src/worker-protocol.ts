import { type JsonValue, snapshotJsonValue } from "./json.ts";

export const INVALID_WORKER_CALL_ID_MESSAGE =
	"worker call id must be a positive safe integer that strictly increases";
const INVALID_WORKER_MESSAGE = "worker emitted an invalid protocol message";

export type WorkerToHost =
	| { type: "log"; text: string }
	| { type: "call"; id: number; name: string; args: JsonValue }
	| { type: "done"; value?: JsonValue }
	| { type: "fail"; kind: "throw" | "invalid-output" | "output-limit"; message: string };

export type HostToWorker =
	| { type: "reply"; id: number; ok: true; value: JsonValue }
	| { type: "reply"; id: number; ok: false; toolName: string; message: string };

export function logicalLineCount(text: string): number {
	return text.split(/\r\n|\r|\n/).length;
}

export function parseWorkerMessage(value: unknown): WorkerToHost {
	if (!isRecord(value) || typeof value.type !== "string") throw invalidWorkerMessage();
	switch (value.type) {
		case "log":
			return parseLogMessage(value);
		case "call":
			return parseCallMessage(value);
		case "done":
			return parseDoneMessage(value);
		case "fail":
			return parseFailureMessage(value);
		default:
			throw invalidWorkerMessage();
	}
}

function parseLogMessage(value: Record<string, unknown>): WorkerToHost {
	if (typeof value.text !== "string") throw invalidWorkerMessage();
	return { type: "log", text: value.text };
}

function parseCallMessage(value: Record<string, unknown>): WorkerToHost {
	if (typeof value.id !== "number" || typeof value.name !== "string") {
		throw invalidWorkerMessage();
	}
	return { type: "call", id: value.id, name: value.name, args: snapshotJsonValue(value.args) };
}

function parseDoneMessage(value: Record<string, unknown>): WorkerToHost {
	return "value" in value
		? { type: "done", value: snapshotJsonValue(value.value) }
		: { type: "done" };
}

function parseFailureMessage(value: Record<string, unknown>): WorkerToHost {
	if (!isWorkerFailureKind(value.kind) || typeof value.message !== "string") {
		throw invalidWorkerMessage();
	}
	return { type: "fail", kind: value.kind, message: value.message };
}

function isWorkerFailureKind(value: unknown): value is "throw" | "invalid-output" | "output-limit" {
	return value === "throw" || value === "invalid-output" || value === "output-limit";
}

function invalidWorkerMessage(): Error {
	return new Error(INVALID_WORKER_MESSAGE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
