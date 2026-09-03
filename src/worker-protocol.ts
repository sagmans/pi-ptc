import type { ArtifactRuntime } from "./artifacts.ts";
import type { JsonValue } from "./json.ts";
import type { OutputLimitName, OutputLimitSubject } from "./output-limit.ts";
import { parseWorkerMessageValue } from "./worker-protocol-parser.ts";

export const WORKER_BINDING_NAME = "tools";

export type WorkerBootData = {
	program: string;
	bindingNames: string[];
	maxOutputBytes: number;
	maxOutputLines: number;
	artifacts?: ArtifactRuntime;
};

export const INVALID_WORKER_CALL_ID_MESSAGE =
	"worker call id must be a positive safe integer that strictly increases";

export type WorkerToHost =
	| { type: "log"; text: string }
	| { type: "call"; id: number; name: string; args: JsonValue }
	| { type: "done"; value?: JsonValue }
	| {
			type: "fail";
			kind: "program-compile" | "program-runtime" | "program-result-json";
			message: string;
	  }
	| {
			type: "fail";
			kind: "binding-arguments-json" | "binding-arguments-limit" | "tool-call" | "result-delivery";
			toolName: string;
			message: string;
	  }
	| {
			type: "fail";
			kind: "output-limit";
			subject: OutputLimitSubject;
			limitName: OutputLimitName;
			observed: number;
			limit: number;
	  };

export type BindingFailureKind =
	| "binding-arguments-json"
	| "binding-arguments-limit"
	| "tool-call"
	| "result-delivery";

export type HostToWorker =
	| { type: "reply"; id: number; ok: true; value: JsonValue }
	| {
			type: "reply";
			id: number;
			ok: false;
			kind: "tool-call";
			toolName: string;
			message: string;
	  }
	| {
			type: "result-delivery";
			id: number;
			kind: "result-delivery";
			toolName: string;
			message: string;
	  };

export function parseWorkerMessage(value: unknown): WorkerToHost {
	return parseWorkerMessageValue(value) as WorkerToHost;
}
