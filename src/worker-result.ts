// Worker completion measurement and automatic spill. Only successful final
// results spill; byte overflow keeps precedence over line overflow.

import type { MessagePort } from "node:worker_threads";

import { writeResultArtifact } from "./artifacts.ts";
import * as outputLimit from "./output-limit.ts";
import { logicalJsonLineCount } from "./output-measure.ts";
import { snapshotWorkerPayload } from "./worker-bindings.ts";
import { postWorkerFailure, postWorkerOutputLimit } from "./worker-failure.ts";
import type { WorkerBootData } from "./worker-protocol.ts";

const UTF8_ENCODING = "utf8";

export async function completeWorkerResult(
	port: MessagePort,
	boot: WorkerBootData,
	value: unknown,
): Promise<void> {
	let snapshot: ReturnType<typeof snapshotWorkerPayload>;
	try {
		snapshot = snapshotWorkerPayload(value, boot.maxOutputBytes);
	} catch (error) {
		postWorkerFailure(port, boot, error, "program-result-json");
		return;
	}
	if (!snapshot.ok) {
		await settleOverflowedResult(port, boot, snapshot.value, snapshot.bytes, true);
		return;
	}
	const lines = logicalJsonLineCount(snapshot.value);
	if (lines > boot.maxOutputLines) {
		await settleOverflowedResult(port, boot, snapshot.value, lines, false);
		return;
	}
	port.postMessage({ type: "done", value: snapshot.value });
}

async function settleOverflowedResult(
	port: MessagePort,
	boot: WorkerBootData,
	value: ReturnType<typeof snapshotWorkerPayload>["value"],
	observed: number,
	byteOverflow: boolean,
): Promise<void> {
	if (boot.artifacts) {
		try {
			const reference = await writeResultArtifact(boot.artifacts, value);
			if (deliverableReference(reference, boot)) {
				port.postMessage({ type: "done", value: reference });
				return;
			}
		} catch (error) {
			postWorkerFailure(port, boot, error);
			return;
		}
	}
	postWorkerOutputLimit(
		port,
		outputLimit.PROGRAM_RESULT_SUBJECT,
		byteOverflow ? outputLimit.MAX_OUTPUT_BYTES_NAME : outputLimit.MAX_OUTPUT_LINES_NAME,
		observed,
		byteOverflow ? boot.maxOutputBytes : boot.maxOutputLines,
	);
}

function deliverableReference(
	reference: Awaited<ReturnType<typeof writeResultArtifact>>,
	boot: WorkerBootData,
): boolean {
	const bytes = Buffer.byteLength(JSON.stringify(reference), UTF8_ENCODING);
	return bytes <= boot.maxOutputBytes;
}
