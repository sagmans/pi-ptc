import type { MessagePort } from "node:worker_threads";

import { type JsonValue, LosslessJsonError, snapshotJsonValue } from "./json.ts";
import type { HostToWorker, WorkerBootData } from "./worker-protocol.ts";

const BINDING_ARGUMENT_LIMIT_MESSAGE = "binding arguments exceed maxOutputBytes";

export type ToolCallFailureKind =
	| "binding-arguments-json"
	| "binding-arguments-limit"
	| "tool-call";
const UTF8_ENCODING = "utf8";

export class ToolResultDeliveryError extends Error {
	readonly executionSucceeded = true;
	readonly retryUnsafe = true;
	readonly toolName: string;

	constructor(toolName: string, message: string) {
		super(message);
		this.name = "ToolResultDeliveryError";
		this.toolName = toolName;
	}
}

export class ToolCallError extends Error {
	readonly failureKind: ToolCallFailureKind;
	readonly toolName: string;

	constructor(toolName: string, message: string, failureKind: ToolCallFailureKind = "tool-call") {
		super(message);
		this.name = "ToolCallError";
		this.failureKind = failureKind;
		this.toolName = toolName;
	}
}

type WorkerPayloadSnapshot = { ok: true; value: JsonValue } | { ok: false; bytes: number };

export function snapshotWorkerPayload(value: unknown, maximumBytes: number): WorkerPayloadSnapshot {
	const snapshot = snapshotJsonValue(value);
	const bytes = Buffer.byteLength(JSON.stringify(snapshot), UTF8_ENCODING);
	return bytes <= maximumBytes ? { ok: true, value: snapshot } : { ok: false, bytes };
}

export function createWorkerBindings(
	port: MessagePort,
	boot: WorkerBootData,
): Record<string, (args: JsonValue) => Promise<JsonValue>> {
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
	const bindings: Record<string, (args: JsonValue) => Promise<JsonValue>> = Object.create(null);
	for (const name of boot.bindingNames) {
		bindings[name] = async (args: JsonValue) => {
			const id = nextCallId;
			nextCallId += 1;
			let snapshot: WorkerPayloadSnapshot;
			try {
				snapshot = snapshotWorkerPayload(args, boot.maxOutputBytes);
			} catch (error) {
				if (error instanceof LosslessJsonError) {
					throw new ToolCallError(name, error.message, "binding-arguments-json");
				}
				throw error;
			}
			if (!snapshot.ok) {
				throw new ToolCallError(name, BINDING_ARGUMENT_LIMIT_MESSAGE, "binding-arguments-limit");
			}
			const result = new Promise<JsonValue>((resolve, reject) => {
				pending.set(id, { resolve, reject });
			});
			port.postMessage({ type: "call", id, name, args: snapshot.value });
			return await result;
		};
	}
	return bindings;
}
