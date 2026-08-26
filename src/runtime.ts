// Host-side code runtime. The worker is a containment isolate, not a sandbox.

import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { PROGRAM_WRAPPER_NAME, SHIPPED_PTC_CONFIG } from "./config.ts";
import { type JsonValue, snapshotJsonValue } from "./json.ts";
import { stripProgram } from "./strip.ts";

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));
const LOG_SEPARATOR_BYTES = 1;
const EMPTY_LOGS_SERIALIZED_BYTES = Buffer.byteLength(JSON.stringify({ logs: [] }), "utf8");
const INVALID_WORKER_CALL_ID_MESSAGE =
	"worker call id must be a positive safe integer that strictly increases";
const INVALID_WORKER_MESSAGE = "worker emitted an invalid protocol message";

// Required internal contract: bindings must settle after abort because host work cannot be abandoned safely.
export type BindingFn = (args: JsonValue, signal: AbortSignal) => Promise<JsonValue>;

export type CodeRunFailure =
	| { kind: "throw"; message: string }
	| { kind: "timeout" }
	| { kind: "abort" }
	| { kind: "invalid-output"; message: string }
	| { kind: "output-limit" }
	| { kind: "dispatch-limit" }
	| { kind: "dangling-dispatch" }
	| { kind: "worker-exit"; message: string };

export type CodeRunRequest = {
	program: string;
	bindings?: {
		global: "tools";
		functions: Record<string, BindingFn>;
	};
	signal?: AbortSignal;
	timeoutMs?: number;
	maxOutputBytes?: number;
	maxOutputLines?: number;
	maxBindingCalls?: number;
};

export type CodeRunResult = {
	logs: string[];
	result?: JsonValue;
	error?: CodeRunFailure;
};

type WorkerToHost =
	| { type: "log"; text: string }
	| { type: "call"; id: number; name: string; args: JsonValue }
	| { type: "done"; value?: JsonValue }
	| { type: "fail"; kind: "throw" | "invalid-output"; message: string };

type HostToWorker =
	| { type: "reply"; id: number; ok: true; value: JsonValue }
	| { type: "reply"; id: number; ok: false; toolName: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function logicalLineCount(text: string): number {
	return text.split(/\r\n|\r|\n/).length;
}

function parseWorkerMessage(value: unknown): WorkerToHost {
	if (!isRecord(value) || typeof value.type !== "string") {
		throw new Error(INVALID_WORKER_MESSAGE);
	}
	if (value.type === "log" && typeof value.text === "string") {
		return { type: "log", text: value.text };
	}
	if (value.type === "call" && typeof value.id === "number" && typeof value.name === "string") {
		return { type: "call", id: value.id, name: value.name, args: snapshotJsonValue(value.args) };
	}
	if (value.type === "done") {
		return "value" in value
			? { type: "done", value: snapshotJsonValue(value.value) }
			: { type: "done" };
	}
	if (
		value.type === "fail" &&
		(value.kind === "throw" || value.kind === "invalid-output") &&
		typeof value.message === "string"
	) {
		return { type: "fail", kind: value.kind, message: value.message };
	}
	throw new Error(INVALID_WORKER_MESSAGE);
}

export async function runCode(request: CodeRunRequest): Promise<CodeRunResult> {
	let program: string;
	try {
		// Strip a function wrapper so top-level return/await stay legal.
		program = stripProgram(
			`async function ${PROGRAM_WRAPPER_NAME}(tools, ToolCallError, console) {
${request.program}
}`,
		);
	} catch (error) {
		return {
			logs: [],
			error: { kind: "throw", message: error instanceof Error ? error.message : String(error) },
		};
	}

	const functions = request.bindings?.functions ?? {};
	const timeoutMs = request.timeoutMs ?? SHIPPED_PTC_CONFIG.timeoutMs;
	const maxOutputBytes = request.maxOutputBytes ?? SHIPPED_PTC_CONFIG.maxOutputBytes;
	const maxOutputLines = request.maxOutputLines ?? SHIPPED_PTC_CONFIG.maxOutputLines;
	const maxBindingCalls = request.maxBindingCalls ?? SHIPPED_PTC_CONFIG.maxDispatches;
	const logs: string[] = [];
	let logOutputBytes = EMPTY_LOGS_SERIALIZED_BYTES;
	let logOutputLines = 0;
	const invocation = new AbortController();
	const activeBindings = new Map<number, Promise<void>>();
	let acceptedBindingCalls = 0;
	let lastWorkerCallId = 0;
	let closing = false;
	const worker = new Worker(WORKER_PATH, {
		env: {},
		resourceLimits: {
			maxOldGenerationSizeMb: SHIPPED_PTC_CONFIG.workerMaxOldGenerationSizeMb,
		},
		workerData: {
			program,
			bindingNames: Object.keys(functions),
		},
	});

	return await new Promise<CodeRunResult>((resolve) => {
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
			await Promise.allSettled([...activeBindings.values()]);
			await worker.terminate().catch(() => undefined);
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
			if (message.type === "log") {
				const separatorBytes = logs.length === 0 ? 0 : LOG_SEPARATOR_BYTES;
				const nextBytes =
					logOutputBytes + separatorBytes + Buffer.byteLength(JSON.stringify(message.text), "utf8");
				const nextLines = logOutputLines + logicalLineCount(message.text);
				if (nextBytes > maxOutputBytes || nextLines > maxOutputLines) {
					finish({ logs: [...logs], error: { kind: "output-limit" } }, true);
					return;
				}
				logOutputBytes = nextBytes;
				logOutputLines = nextLines;
				logs.push(message.text);
				return;
			}
			if (message.type === "call") {
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
						toolName: message.name,
						message: `unknown binding: ${message.name}`,
					});
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
							toolName,
							message: errorMessage,
						});
					})
					.finally(() => {
						if (activeBindings.get(message.id) === settlement) {
							activeBindings.delete(message.id);
						}
					});
				activeBindings.set(message.id, settlement);
				return;
			}
			if (message.type === "done") {
				if (activeBindings.size > 0) {
					finish({ logs: [...logs], error: { kind: "dangling-dispatch" } }, true);
					return;
				}
				finish(
					"value" in message ? { logs: [...logs], result: message.value } : { logs: [...logs] },
					false,
				);
				return;
			}
			finish({ logs: [...logs], error: { kind: message.kind, message: message.message } }, true);
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
