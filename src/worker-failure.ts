import type { MessagePort } from "node:worker_threads";

import * as outputLimit from "./output-limit.ts";
import { ToolCallError, ToolResultDeliveryError } from "./worker-bindings.ts";
import { logicalLineCount, type WorkerBootData } from "./worker-protocol.ts";

const UTF8_ENCODING = "utf8";
type ProgramFailureKind = "program-compile" | "program-result-json";

export function postWorkerOutputLimit(
	port: MessagePort,
	subject: outputLimit.OutputLimitSubject,
	limitName: outputLimit.OutputLimitName,
	observed: number,
	limit: number,
): void {
	port.postMessage({ type: "fail", kind: "output-limit", subject, limitName, observed, limit });
}

export function postWorkerFailure(
	port: MessagePort,
	boot: WorkerBootData,
	error: unknown,
	programKind?: ProgramFailureKind,
): void {
	const message = error instanceof Error ? error.message : String(error);
	const messageBytes = Buffer.byteLength(message, UTF8_ENCODING);
	if (messageBytes > boot.maxOutputBytes) {
		postWorkerOutputLimit(
			port,
			outputLimit.WORKER_ERROR_SUBJECT,
			outputLimit.MAX_OUTPUT_BYTES_NAME,
			messageBytes,
			boot.maxOutputBytes,
		);
		return;
	}
	const messageLines = logicalLineCount(message);
	if (messageLines > boot.maxOutputLines) {
		postWorkerOutputLimit(
			port,
			outputLimit.WORKER_ERROR_SUBJECT,
			outputLimit.MAX_OUTPUT_LINES_NAME,
			messageLines,
			boot.maxOutputLines,
		);
		return;
	}
	if (programKind !== undefined) {
		port.postMessage({ type: "fail", kind: programKind, message });
		return;
	}
	if (error instanceof ToolResultDeliveryError) {
		port.postMessage({
			type: "fail",
			kind: "result-delivery",
			toolName: error.toolName,
			message,
		});
		return;
	}
	if (error instanceof ToolCallError) {
		port.postMessage({
			type: "fail",
			kind: error.failureKind,
			toolName: error.toolName,
			message,
		});
		return;
	}
	port.postMessage({ type: "fail", kind: "program-runtime", message });
}
