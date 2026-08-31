import { readFileSync } from "node:fs";

import type { DispatchRenderResult } from "../../src/bridge.ts";

export const DESCRIPTION = "inspect files";
export const LEGACY_DESCRIPTION = "legacy";
export const CONTROLLED_COMMAND = "before\u001b[2Jafter";
export const SANITIZED_COMMAND = "beforeafter";
export const EXTENDED_CONTROLLED_TEXT =
	"before\u001b[?1049hmiddle\u001bc\u0007\u009b31mred\u001bPpayload\u001b\\after";
export const EXTENDED_SANITIZED_TEXT = "beforemiddleredafter";
export const OVERSIZED_ARGUMENT_TEXT = "argument-data".repeat(100_000);
export const OVERSIZED_DESCRIPTION_TAIL = "DESCRIPTION_TAIL_MUST_BE_OMITTED";
export const OVERSIZED_ERROR_TAIL = "ERROR_TAIL_MUST_BE_OMITTED";
export const COMPATIBILITY_ERROR_MAX_CHARACTERS = 256;
export const LONG_EXECUTION_ERROR = "failure ".repeat(COMPATIBILITY_ERROR_MAX_CHARACTERS);
export const HOSTILE_DETAILS_ERROR = "hostile details";
export const HOSTILE_RESULT_ERROR = "hostile result";
export const PROTOTYPE_KEY = "__proto__";
export const PROTOTYPE_PATH = "spoofed";
export const PROTOTYPE_JSON = `{"${PROTOTYPE_KEY}":{"path":"${PROTOTYPE_PATH}"}}`;
export const FULL_RENDER_TEXT = "complete text result";
export const FULL_RENDER_DATA = "aW1hZ2UtYnl0ZXM=";
export const OMITTED_RENDER_TEXT = "omitted text result";
export const OMITTED_RENDER_DATA = "b21pdHRlZC1pbWFnZS1ieXRlcw==";
export const FULL_RENDER_RESULT = {
	content: [
		{ type: "text", text: FULL_RENDER_TEXT },
		{ type: "image", data: FULL_RENDER_DATA, mimeType: "image/png" },
	],
	details: { path: "complete.png" },
	isError: false,
} satisfies DispatchRenderResult;
export const OMITTED_RENDER_RESULT = {
	content: [
		{ type: "text", text: OMITTED_RENDER_TEXT },
		{ type: "image", data: OMITTED_RENDER_DATA, mimeType: "image/png" },
	],
	details: { path: "omitted.png" },
	isError: false,
} satisfies DispatchRenderResult;
export const RENDER_DETAILS_BUDGET_BYTES = Buffer.byteLength(
	JSON.stringify(FULL_RENDER_RESULT),
	"utf8",
);
export const PREFLIGHT_RENDER_BUDGET_BYTES = 64;
export const OVERSIZED_RENDER_VALUE = "x".repeat(PREFLIGHT_RENDER_BUDGET_BYTES + 1);
export const INCOMPATIBLE_RENDER_VALUE = 42;
export const CONTROLLED_RESULT_KEY = `key${CONTROLLED_COMMAND}`;
export const SANITIZED_RESULT_KEY = `key${SANITIZED_COMMAND}`;
export const VERSION_TWO_SUCCESS_FIXTURE = "version-2-success.json";
export const VERSION_TWO_ERRORS_FIXTURE = "version-2-errors.json";
export const VERSION_TWO_MALFORMED_FIXTURE = "version-2-malformed.json";
export const LEGACY_NO_ID_FIXTURE = "legacy-no-id.json";
export const GENERIC_TOOL_NAME = "mcp.server/call[odd name]";
export const GENERIC_REDACTION_MARKER = "[REDACTED]";
export const GENERIC_ARGUMENT_MAX_BYTES = 8192;
export const GENERIC_LARGE_VALUE = "GENERIC_PRIVATE_VALUE".repeat(10_000);
export const CONTROLLED_TOOL_NAMES = [
	"before\u001b[31mafter",
	"before\u001b]0;unsafe-title\u0007after",
	"before\u001b_payload\u001b\\after",
	"before\nafter",
	"before\u009b31mafter",
] as const;
export const COMPOUND_CREDENTIAL_VALUES = [
	"private-access",
	"private-refresh",
	"private-auth",
	"private-bearer",
	"private-session",
] as const;

export const START_DISPATCH = {
	id: 2,
	name: "read" as const,
	args: { path: "b" },
	status: "start" as const,
};

export function loadDispatchFixture(name: string): unknown {
	return JSON.parse(
		readFileSync(new URL(`../fixtures/dispatch-details/${name}`, import.meta.url), "utf8"),
	);
}

export const FINAL_DISPATCH = {
	id: 1,
	name: "read" as const,
	args: { path: "a" },
	status: "ok" as const,
	preview: "done",
};
