import type { MessagePort } from "node:worker_threads";

import { type JsonValue, snapshotJsonValue } from "./json.ts";
import type { HostToWorker, WorkerBootData } from "./worker-protocol.ts";

const BINDING_ARGUMENT_LIMIT_MESSAGE = "binding arguments exceed maxOutputBytes";
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
	readonly toolName: string;

	constructor(toolName: string, message: string) {
		super(message);
		this.name = "ToolCallError";
		this.toolName = toolName;
	}
}

export function snapshotWorkerPayload(value: unknown, maximumBytes: number): JsonValue | undefined {
	const snapshot = snapshotJsonValue(value);
	return Buffer.byteLength(JSON.stringify(snapshot), UTF8_ENCODING) <= maximumBytes
		? snapshot
		: undefined;
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
			const snapshot = snapshotWorkerPayload(args, boot.maxOutputBytes);
			if (snapshot === undefined) throw new ToolCallError(name, BINDING_ARGUMENT_LIMIT_MESSAGE);
			const result = new Promise<JsonValue>((resolve, reject) => {
				pending.set(id, { resolve, reject });
			});
			port.postMessage({ type: "call", id, name, args: snapshot });
			return await result;
		};
	}
	return bindings;
}
