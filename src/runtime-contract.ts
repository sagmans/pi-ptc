import type { JsonValue } from "./json.ts";

// Bindings should settle after abort, while the deadline prevents a broken binding from pinning Pi.
export type BindingFn = (args: JsonValue, signal: AbortSignal) => Promise<JsonValue>;

export type CodeRunFailure =
	| { kind: "program-transform"; message: string }
	| { kind: "program-compile"; message: string }
	| { kind: "program-runtime"; message: string }
	| { kind: "timeout" }
	| { kind: "abort" }
	| { kind: "binding-arguments-json"; toolName: string; message: string }
	| { kind: "binding-arguments-limit"; toolName: string; message: string }
	| { kind: "tool-call"; toolName: string; message: string }
	| { kind: "program-result-json"; message: string }
	| { kind: "result-delivery"; toolName: string; message: string }
	| { kind: "worker-protocol"; message: string }
	| { kind: "output-limit"; message: string }
	| { kind: "dispatch-limit" }
	| { kind: "dangling-dispatch" }
	| { kind: "orphan-limit" }
	| { kind: "worker-exit"; message: string };

export type CodeRunRequest = {
	program: string;
	bindings?: {
		functions: Record<string, BindingFn>;
	};
	signal?: AbortSignal;
	timeoutMs?: number;
	drainTimeoutMs?: number;
	maxOutputBytes?: number;
	maxOutputLines?: number;
	maxBindingCalls?: number;
};

export type CodeRunResult = {
	logs: string[];
	result?: JsonValue;
	error?: CodeRunFailure;
};
