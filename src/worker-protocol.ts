import { type JsonValue, snapshotJsonValue } from "./json.ts";
import {
	isOutputLimitName,
	isOutputLimitSubject,
	type OutputLimitName,
	type OutputLimitSubject,
} from "./output-limit.ts";

export const WORKER_BINDING_NAME = "tools";

export type WorkerBootData = {
	program: string;
	bindingNames: string[];
	maxOutputBytes: number;
	maxOutputLines: number;
};

export const INVALID_WORKER_CALL_ID_MESSAGE =
	"worker call id must be a positive safe integer that strictly increases";
const INVALID_WORKER_MESSAGE = "worker emitted an invalid protocol message";

export type WorkerToHost =
	| { type: "log"; text: string }
	| { type: "call"; id: number; name: string; args: JsonValue }
	| { type: "done"; value?: JsonValue }
	| {
			type: "fail";
			kind: "program-compile" | "program-runtime" | "program-result-json";
			message: string;
	  }
	| {
			type: "fail";
			kind: "binding-arguments-json" | "binding-arguments-limit" | "tool-call" | "result-delivery";
			toolName: string;
			message: string;
	  }
	| {
			type: "fail";
			kind: "output-limit";
			subject: OutputLimitSubject;
			limitName: OutputLimitName;
			observed: number;
			limit: number;
	  };

export type BindingFailureKind =
	| "binding-arguments-json"
	| "binding-arguments-limit"
	| "tool-call"
	| "result-delivery";

export type HostToWorker =
	| { type: "reply"; id: number; ok: true; value: JsonValue }
	| {
			type: "reply";
			id: number;
			ok: false;
			kind: "tool-call";
			toolName: string;
			message: string;
	  }
	| {
			type: "result-delivery";
			id: number;
			kind: "result-delivery";
			toolName: string;
			message: string;
	  };

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
	if (value.kind === "output-limit") return parseOutputLimitFailure(value);
	if (!isWorkerFailureKind(value.kind) || typeof value.message !== "string") {
		throw invalidWorkerMessage();
	}
	if (isBindingFailureKind(value.kind)) {
		if (typeof value.toolName !== "string") throw invalidWorkerMessage();
		return { type: "fail", kind: value.kind, toolName: value.toolName, message: value.message };
	}
	return { type: "fail", kind: value.kind, message: value.message };
}

function parseOutputLimitFailure(value: Record<string, unknown>): WorkerToHost {
	if (
		!isOutputLimitSubject(value.subject) ||
		!isOutputLimitName(value.limitName) ||
		typeof value.observed !== "number" ||
		!Number.isSafeInteger(value.observed) ||
		typeof value.limit !== "number" ||
		!Number.isSafeInteger(value.limit)
	) {
		throw invalidWorkerMessage();
	}
	return {
		type: "fail",
		kind: "output-limit",
		subject: value.subject,
		limitName: value.limitName,
		observed: value.observed,
		limit: value.limit,
	};
}

type WorkerFailureKind = Extract<WorkerToHost, { type: "fail"; message: string }>["kind"];

function isWorkerFailureKind(value: unknown): value is WorkerFailureKind {
	return (
		value === "program-compile" ||
		value === "program-runtime" ||
		value === "program-result-json" ||
		isBindingFailureKind(value)
	);
}

function isBindingFailureKind(value: unknown): value is BindingFailureKind {
	return (
		value === "binding-arguments-json" ||
		value === "binding-arguments-limit" ||
		value === "tool-call" ||
		value === "result-delivery"
	);
}

function invalidWorkerMessage(): Error {
	return new Error(INVALID_WORKER_MESSAGE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
