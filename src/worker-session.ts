import type { Worker } from "node:worker_threads";

import { ToolResultDeliveryError } from "./canonical.ts";
import { snapshotJsonValue } from "./json.ts";
import { processOrphanBindingGovernor } from "./orphan-binding-governor.ts";
import type { BindingFn, CodeRunRequest, CodeRunResult } from "./runtime-contract.ts";
import {
	type HostToWorker,
	INVALID_WORKER_CALL_ID_MESSAGE,
	logicalLineCount,
	parseWorkerMessage,
	type WorkerToHost,
} from "./worker-protocol.ts";

const LOG_SEPARATOR_BYTES = 1;
const EMPTY_LOGS_SERIALIZED_BYTES = Buffer.byteLength(JSON.stringify({ logs: [] }), "utf8");
const UTF8_ENCODING = "utf8";
type WorkerSessionInput = {
	worker: Worker;
	request: CodeRunRequest;
	functions: Record<string, BindingFn>;
	timeoutMs: number;
	drainTimeoutMs: number;
	maxOutputBytes: number;
	maxOutputLines: number;
	maxBindingCalls: number;
	maxOrphanedBindings: number;
};

export function runWorkerSession(input: WorkerSessionInput): Promise<CodeRunResult> {
	return new Promise<CodeRunResult>((resolve) => {
		const {
			worker,
			request,
			functions,
			timeoutMs,
			drainTimeoutMs,
			maxOutputBytes,
			maxOutputLines,
			maxBindingCalls,
			maxOrphanedBindings,
		} = input;
		const logs: string[] = [];
		let logOutputBytes = EMPTY_LOGS_SERIALIZED_BYTES;
		let logOutputLines = 0;
		const invocation = new AbortController();
		const activeBindings = new Map<number, Promise<void>>();
		let acceptedBindingCalls = 0;
		let lastWorkerCallId = 0;
		let closing = false;
		let timer: ReturnType<typeof setTimeout>;

		const cleanupListeners = (): void => {
			clearTimeout(timer);
			request.signal?.removeEventListener("abort", onAbort);
			worker.off("message", onMessage);
			worker.off("error", onError);
			worker.off("exit", onExit);
		};

		const close = async (outcome: CodeRunResult, mustAbort: boolean): Promise<void> => {
			if (closing) return;
			closing = true;
			if (mustAbort) invocation.abort();
			const bindingsToDrain = [...activeBindings.values()];
			await worker.terminate().catch(() => undefined);
			let drainTimer: ReturnType<typeof setTimeout> | undefined;
			const drained = await Promise.race([
				Promise.allSettled(bindingsToDrain).then(() => true),
				new Promise<false>((drainElapsed) => {
					drainTimer = setTimeout(() => drainElapsed(false), drainTimeoutMs);
				}),
			]);
			if (drainTimer !== undefined) clearTimeout(drainTimer);
			if (!drained) activeBindings.clear();
			cleanupListeners();
			resolve(outcome);
		};

		const finish = (outcome: CodeRunResult, mustAbort: boolean): void => {
			void close(outcome, mustAbort);
		};

		const postReply = (message: HostToWorker): void => {
			if (closing) return;
			try {
				worker.postMessage(message);
			} catch (error) {
				finish(
					{
						logs: [...logs],
						error: {
							kind: "worker-exit",
							message: error instanceof Error ? error.message : String(error),
						},
					},
					true,
				);
			}
		};

		const handleLog = (message: Extract<WorkerToHost, { type: "log" }>): void => {
			const separatorBytes = logs.length === 0 ? 0 : LOG_SEPARATOR_BYTES;
			const nextBytes =
				logOutputBytes +
				separatorBytes +
				Buffer.byteLength(JSON.stringify(message.text), UTF8_ENCODING);
			const nextLines = logOutputLines + logicalLineCount(message.text);
			if (nextBytes > maxOutputBytes || nextLines > maxOutputLines) {
				finish({ logs: [...logs], error: { kind: "output-limit" } }, true);
				return;
			}
			logOutputBytes = nextBytes;
			logOutputLines = nextLines;
			logs.push(message.text);
		};

		const handleCall = (message: Extract<WorkerToHost, { type: "call" }>): void => {
			if (processOrphanBindingGovernor.active >= maxOrphanedBindings) {
				finish({ logs: [...logs], error: { kind: "orphan-limit" } }, true);
				return;
			}
			if (!Number.isSafeInteger(message.id) || message.id <= lastWorkerCallId) {
				finish(
					{
						logs: [...logs],
						error: { kind: "invalid-output", message: INVALID_WORKER_CALL_ID_MESSAGE },
					},
					true,
				);
				return;
			}
			lastWorkerCallId = message.id;
			acceptedBindingCalls += 1;
			if (acceptedBindingCalls > maxBindingCalls) {
				finish({ logs: [...logs], error: { kind: "dispatch-limit" } }, true);
				return;
			}
			const binding = functions[message.name];
			if (!binding) {
				postReply({
					type: "reply",
					id: message.id,
					ok: false,
					kind: "tool-call",
					toolName: message.name,
					message: `unknown binding: ${message.name}`,
				});
				return;
			}
			const reservation = processOrphanBindingGovernor.acquire(maxOrphanedBindings);
			if (!reservation) {
				finish({ logs: [...logs], error: { kind: "orphan-limit" } }, true);
				return;
			}
			const settlement = Promise.resolve()
				.then(() => binding(message.args, invocation.signal))
				.then((value) => {
					postReply({
						type: "reply",
						id: message.id,
						ok: true,
						value: snapshotJsonValue(value),
					});
				})
				.catch((error: unknown) => {
					const toolName =
						error instanceof Error && "toolName" in error && typeof error.toolName === "string"
							? error.toolName
							: message.name;
					const errorMessage = error instanceof Error ? error.message : String(error);
					postReply({
						type: "reply",
						id: message.id,
						ok: false,
						kind: error instanceof ToolResultDeliveryError ? "result-delivery" : "tool-call",
						toolName,
						message: errorMessage,
					});
				})
				.finally(() => {
					reservation.release();
					if (activeBindings.get(message.id) === settlement) {
						activeBindings.delete(message.id);
					}
				});
			activeBindings.set(message.id, settlement);
		};

		const handleDone = (message: Extract<WorkerToHost, { type: "done" }>): void => {
			if (activeBindings.size > 0) {
				finish({ logs: [...logs], error: { kind: "dangling-dispatch" } }, true);
				return;
			}
			finish(
				"value" in message ? { logs: [...logs], result: message.value } : { logs: [...logs] },
				false,
			);
		};

		const handleFailure = (message: Extract<WorkerToHost, { type: "fail" }>): void => {
			if (
				message.kind === "output-limit" ||
				Buffer.byteLength(message.message, UTF8_ENCODING) > maxOutputBytes ||
				logicalLineCount(message.message) > maxOutputLines
			) {
				finish({ logs: [...logs], error: { kind: "output-limit" } }, true);
				return;
			}
			finish({ logs: [...logs], error: { kind: message.kind, message: message.message } }, true);
		};

		const onAbort = (): void => {
			finish({ logs: [...logs], error: { kind: "abort" } }, true);
		};

		const onMessage = (raw: unknown): void => {
			if (closing) return;
			let message: WorkerToHost;
			try {
				message = parseWorkerMessage(raw);
			} catch (error) {
				finish(
					{
						logs: [...logs],
						error: {
							kind: "invalid-output",
							message: error instanceof Error ? error.message : String(error),
						},
					},
					true,
				);
				return;
			}
			switch (message.type) {
				case "log":
					handleLog(message);
					break;
				case "call":
					handleCall(message);
					break;
				case "done":
					handleDone(message);
					break;
				case "fail":
					handleFailure(message);
					break;
				default: {
					const _never: never = message;
					throw new Error(String(_never));
				}
			}
		};

		const onError = (error: Error): void => {
			finish({ logs: [...logs], error: { kind: "throw", message: error.message } }, true);
		};

		const onExit = (code: number): void => {
			if (closing) return;
			finish(
				{
					logs: [...logs],
					error: { kind: "worker-exit", message: `worker exited with code ${code}` },
				},
				true,
			);
		};

		worker.on("message", onMessage);
		worker.on("error", onError);
		worker.on("exit", onExit);
		timer = setTimeout(() => {
			finish({ logs: [...logs], error: { kind: "timeout" } }, true);
		}, timeoutMs);
		request.signal?.addEventListener("abort", onAbort, { once: true });
		if (request.signal?.aborted) onAbort();
	});
}
