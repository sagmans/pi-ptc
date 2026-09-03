import type { CodeRunFailure } from "./runtime-contract.ts";
import { renderSafeJsonStringLiteral } from "./schema-signature.ts";

type FailureKind = CodeRunFailure["kind"];
type FailureDefinition = {
	code: string;
	cause?: string;
	resolution: string;
	retrySafety: string;
};

const RETRY_SAFE = "safe; no nested tool executed";
const RETRY_UNSAFE = "unsafe; execution may have succeeded and retry may repeat effects";
const RETRY_VERIFY = "verify state before retrying; nested tools may have executed";

const FAILURE_DEFINITIONS = Object.freeze({
	abort: {
		code: "PTC_ABORTED",
		cause: "The invocation was cancelled.",
		resolution: "Check nested dispatch rows, then submit a new call only if needed.",
		retrySafety: RETRY_VERIFY,
	},
	"binding-arguments-json": {
		code: "PTC_BINDING_ARGUMENT_JSON",
		resolution:
			"Pass one lossless-JSON value using concrete values; omit undefined fields or use null.",
		retrySafety: RETRY_VERIFY,
	},
	"binding-arguments-limit": {
		code: "PTC_BINDING_ARGUMENT_LIMIT",
		resolution: "Reduce the binding arguments and submit a corrected call.",
		retrySafety: RETRY_VERIFY,
	},
	"dangling-dispatch": {
		code: "PTC_DANGLING_DISPATCH",
		cause: "The program returned while a nested dispatch was still pending.",
		resolution: "Await every binding promise, including every Promise.all result.",
		retrySafety: RETRY_VERIFY,
	},
	"dispatch-limit": {
		code: "PTC_DISPATCH_LIMIT",
		cause: "The program exceeded the configured nested-dispatch limit.",
		resolution: "Reduce or split the tool calls, then verify effects before continuing.",
		retrySafety: RETRY_VERIFY,
	},
	"orphan-limit": {
		code: "PTC_ORPHAN_LIMIT",
		cause: "Process-wide unresolved binding capacity is exhausted.",
		resolution: "Wait for outstanding work to settle or restart Pi before continuing.",
		retrySafety: RETRY_VERIFY,
	},
	"output-limit": {
		code: "PTC_OUTPUT_LIMIT",
		resolution: "Return a smaller projection and keep console output concise.",
		retrySafety: RETRY_VERIFY,
	},
	"program-compile": {
		code: "PTC_PROGRAM_COMPILE",
		resolution:
			"Submit a corrected async-function body without imports, exports, or Markdown fences.",
		retrySafety: RETRY_SAFE,
	},
	"program-result-json": {
		code: "PTC_PROGRAM_RESULT_JSON",
		resolution: "Return only lossless JSON; convert unsupported values and omit undefined fields.",
		retrySafety: RETRY_VERIFY,
	},
	"program-runtime": {
		code: "PTC_PROGRAM_RUNTIME",
		resolution:
			"Correct the reported runtime error, then verify prior dispatch effects before retrying.",
		retrySafety: RETRY_VERIFY,
	},
	"program-transform": {
		code: "PTC_PROGRAM_TRANSFORM",
		resolution: "Prefer plain JavaScript and submit a syntactically complete async-function body.",
		retrySafety: RETRY_SAFE,
	},
	"result-delivery": {
		code: "PTC_TOOL_RESULT_DELIVERY",
		resolution:
			"Inspect external state and nested dispatch details; never retry a mutation blindly.",
		retrySafety: RETRY_UNSAFE,
	},
	"tool-call": {
		code: "PTC_TOOL_CALL",
		resolution: "Correct the arguments or address the reported tool failure before continuing.",
		retrySafety: RETRY_VERIFY,
	},
	"worker-exit": {
		code: "PTC_WORKER_EXIT",
		resolution: "Inspect nested dispatch rows and restart Pi if the failure repeats.",
		retrySafety: RETRY_VERIFY,
	},
	"worker-protocol": {
		code: "PTC_WORKER_PROTOCOL",
		resolution: "Restart Pi and report the failure if it repeats on a supported version.",
		retrySafety: RETRY_VERIFY,
	},
} as const satisfies Record<FailureKind, FailureDefinition>);

export function formatCodeRunFailure(error: CodeRunFailure): string {
	const definition: FailureDefinition = FAILURE_DEFINITIONS[error.kind];
	const tool =
		"toolName" in error ? ` for tool ${renderSafeJsonStringLiteral(error.toolName)}` : "";
	const cause = "message" in error ? `${error.message}${tool}` : definition.cause;
	return `ptc failed [${definition.code}]\nCause: ${cause}\nResolution: ${definition.resolution}\nRetry safety: ${definition.retrySafety}`;
}
