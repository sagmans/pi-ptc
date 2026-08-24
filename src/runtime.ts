// Host-side code runtime. The worker is a containment isolate, not a sandbox.

import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { PROGRAM_WRAPPER_NAME, SHIPPED_PTC_CONFIG } from "./config.ts";
import { type JsonValue, snapshotJsonValue } from "./json.ts";
import { stripProgram } from "./strip.ts";

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
	const logs: string[] = [];
	const worker = new Worker(WORKER_PATH, {
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
				logs.push(message.text);
				return;
			}
			if (message.type === "call") {
				const binding = functions[message.name];
				if (!binding) {
					worker.postMessage({
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
						worker.postMessage({
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
						worker.postMessage({
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
