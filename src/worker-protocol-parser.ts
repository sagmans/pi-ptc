import { snapshotJsonValue } from "./json.ts";
import { isOutputLimitName, isOutputLimitSubject } from "./output-limit.ts";

const INVALID_WORKER_MESSAGE = "worker emitted an invalid protocol message";

export function parseWorkerMessageValue(value: unknown) {
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

function parseLogMessage(value: Record<string, unknown>) {
	if (typeof value.text !== "string") throw invalidWorkerMessage();
	return { type: "log", text: value.text };
}

function parseCallMessage(value: Record<string, unknown>) {
	if (typeof value.id !== "number" || typeof value.name !== "string") {
		throw invalidWorkerMessage();
	}
	return { type: "call", id: value.id, name: value.name, args: snapshotJsonValue(value.args) };
}

function parseDoneMessage(value: Record<string, unknown>) {
	return "value" in value
		? { type: "done", value: snapshotJsonValue(value.value) }
		: { type: "done" };
}

function parseFailureMessage(value: Record<string, unknown>) {
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

function parseOutputLimitFailure(value: Record<string, unknown>) {
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

type WorkerFailureKind =
	| "program-compile"
	| "program-runtime"
	| "program-result-json"
	| BindingFailureKind;
type BindingFailureKind =
	| "binding-arguments-json"
	| "binding-arguments-limit"
	| "tool-call"
	| "result-delivery";

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
