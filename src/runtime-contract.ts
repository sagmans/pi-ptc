import type { JsonValue } from "./json.ts";

// Bindings should settle after abort, while the deadline prevents a broken binding from pinning Pi.
export type BindingFn = (args: JsonValue, signal: AbortSignal) => Promise<JsonValue>;

export type CodeRunFailure =
	| { kind: "throw"; message: string }
	| { kind: "timeout" }
	| { kind: "abort" }
	| { kind: "invalid-output"; message: string }
	| { kind: "output-limit" }
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
	maxOrphanedBindings?: number;
};

export type CodeRunResult = {
	logs: string[];
	result?: JsonValue;
	error?: CodeRunFailure;
};
