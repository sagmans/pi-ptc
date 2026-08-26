// Host-side code runtime. The worker is a containment isolate, not a sandbox.

import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { PROGRAM_WRAPPER_NAME, SHIPPED_PTC_CONFIG } from "./config.ts";
import { type JsonValue, snapshotJsonValue } from "./json.ts";
import { stripProgram } from "./strip.ts";

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));
const LOG_SEPARATOR_BYTES = 1;
const EMPTY_LOGS_SERIALIZED_BYTES = Buffer.byteLength(JSON.stringify({ logs: [] }), "utf8");

export type BindingFn = (args: JsonValue) => Promise<JsonValue>;

export type CodeRunFailure =
	| { kind: "throw"; message: string }
	| { kind: "timeout" }
	| { kind: "abort" }
	| { kind: "invalid-output"; message: string }
	| { kind: "output-limit" }
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

function parseWorkerMessage(value: unknown): WorkerToHost | undefined {
	if (!isRecord(value) || typeof value.type !== "string") return undefined;
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
	return undefined;
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
	const logs: string[] = [];
	let logOutputBytes = EMPTY_LOGS_SERIALIZED_BYTES;
	let logOutputLines = 0;
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

	return await new Promise((resolve) => {
		let settled = false;

		const finish = (outcome: CodeRunResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			request.signal?.removeEventListener("abort", onAbort);
			worker.off("message", onMessage);
			worker.off("error", onError);
			worker.off("exit", onExit);
			void worker.terminate();
			resolve(outcome);
		};

		const postReply = (message: HostToWorker): void => {
			// Binding promises can outlive host ownership after abort or timeout.
			if (settled) return;
			try {
				worker.postMessage(message);
			} catch (error) {
				finish({
					logs: [...logs],
					error: {
						kind: "worker-exit",
						message: error instanceof Error ? error.message : String(error),
					},
				});
			}
		};

		const onAbort = () => {
			finish({ logs: [...logs], error: { kind: "abort" } });
		};
		const timer = setTimeout(() => {
			finish({ logs: [...logs], error: { kind: "timeout" } });
		}, timeoutMs);
		request.signal?.addEventListener("abort", onAbort, { once: true });
		if (request.signal?.aborted) {
			onAbort();
			return;
		}

		const onMessage = (raw: unknown) => {
			let message: WorkerToHost;
			try {
				const parsed = parseWorkerMessage(raw);
				if (!parsed) return;
				message = parsed;
			} catch (error) {
				finish({
					logs: [...logs],
					error: {
						kind: "invalid-output",
						message: error instanceof Error ? error.message : String(error),
					},
				});
				return;
			}
			if (message.type === "log") {
				const separatorBytes = logs.length === 0 ? 0 : LOG_SEPARATOR_BYTES;
				const nextBytes =
					logOutputBytes + separatorBytes + Buffer.byteLength(JSON.stringify(message.text), "utf8");
				const nextLines = logOutputLines + logicalLineCount(message.text);
				if (nextBytes > maxOutputBytes || nextLines > maxOutputLines) {
					finish({ logs: [...logs], error: { kind: "output-limit" } });
					return;
				}
				logOutputBytes = nextBytes;
				logOutputLines = nextLines;
				logs.push(message.text);
				return;
			}
			if (message.type === "call") {
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
				void Promise.resolve()
					.then(() => binding(message.args))
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
					});
				return;
			}
			if (message.type === "done") {
				finish(
					"value" in message ? { logs: [...logs], result: message.value } : { logs: [...logs] },
				);
				return;
			}
			finish({ logs: [...logs], error: { kind: message.kind, message: message.message } });
		};

		const onError = (error: Error) => {
			finish({ logs: [...logs], error: { kind: "throw", message: error.message } });
		};
		const onExit = (code: number) => {
			if (settled) return;
			finish({
				logs: [...logs],
				error: { kind: "worker-exit", message: `worker exited with code ${code}` },
			});
		};

		worker.on("message", onMessage);
		worker.on("error", onError);
		worker.on("exit", onExit);
	});
}
