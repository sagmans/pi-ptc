import { strict as assert } from "node:assert";
import type { DispatchLogEntry, DispatchProgress, FactoryToolSet } from "../../src/bridge.ts";
import * as bridge from "../../src/bridge.ts";
import { CORE_TOOL_NAMES } from "../../src/config.ts";
import type { BindingFn } from "../../src/runtime-contract.ts";
import { createScheduler, type Scheduler } from "../../src/scheduler.ts";
import type { ToolCatalogEntry } from "../../src/tool-catalog.ts";
import type {
	NestedToolDispatchRequest,
	NestedToolDispatchResult,
	NestedToolRuntimeResult,
	ToolExecutor,
} from "../../src/tool-executor.ts";

export const BINDING_SIGNAL = new AbortController().signal;
export const QUEUED_ABORT_FIRST_PATH = "first.txt";
export const QUEUED_ABORT_SECOND_PATH = "second.txt";
export const OPERATION_ABORTED_MESSAGE = "Operation aborted";
export const SCHEDULER_ABORT_MESSAGE = new RegExp(OPERATION_ABORTED_MESSAGE);
export const EARLY_NATIVE_ABORT_MESSAGE = "native aborted before owned work settled";
export const PARTIAL_CANCEL_TEXT = "partial output";
export const PRIVATE_WRITE_CONTENT = "PRIVATE_WRITE_CONTENT".repeat(100);
export const GENERIC_TOOL_NAME = "mcp.server/call[odd name]";
export const OTHER_GENERIC_TOOL_NAME = "__proto__";
export const INACTIVE_TOOL_NAME = "inactive.tool";
export const GENERIC_REDACTION_MARKER = "[REDACTED]";
export const GENERIC_FAILED_MESSAGE = "tool failed";
export const CONTROLLED_TOOL_NAME_CASES = [
	{ raw: "before\u001b[31mafter", safe: "beforeafter" },
	{ raw: "before\u001b]0;unsafe-title\u0007after", safe: "beforeafter" },
	{ raw: "before\u001b_payload\u001b\\after", safe: "beforeafter" },
	{ raw: "before\nafter", safe: "beforeafter" },
	{ raw: "before\u009b31mafter", safe: "beforeafter" },
] as const;
export const CONTROLLED_TOOL_NAME = CONTROLLED_TOOL_NAME_CASES.map(({ raw }) => raw).join(":");
export const OVERSIZED_TOOL_NAME = "tool-name".repeat(1_000);
export const MAX_FORMATTED_TOOL_LINE_BYTES = 512;
export const COMPOUND_CREDENTIAL_VALUES = [
	"private-access",
	"private-refresh",
	"private-auth",
	"private-bearer",
	"private-session",
] as const;

export type ToolBindingsFactory = (
	snapshot: readonly ToolCatalogEntry[],
	executor: ToolExecutor,
	scheduler: Scheduler,
	reporting: {
		appendLog?: (entry: DispatchLogEntry) => void;
		emit?: (name: string, payload: unknown) => void;
		acceptSideEffects?: () => boolean;
		reportDispatch?: (progress: DispatchProgress) => void;
	},
) => Record<string, BindingFn>;

export function createGenericBindings(
	snapshot: readonly ToolCatalogEntry[],
	executor: ToolExecutor,
	scheduler = createScheduler(2),
	reporting: Parameters<ToolBindingsFactory>[3] = {},
): Record<string, BindingFn> {
	const factory = Reflect.get(bridge, "createToolBindings");
	assert.equal(typeof factory, "function", "createToolBindings export must exist");
	return (factory as ToolBindingsFactory)(snapshot, executor, scheduler, reporting);
}

export function catalogEntry(
	name: string,
	executionMode?: "parallel" | "sequential",
): ToolCatalogEntry {
	return {
		name,
		definition: { name },
		executable: {
			parameters: { type: "object" },
			...(executionMode ? { executionMode } : {}),
			async execute() {
				throw new Error("catalog executable must not run directly from bindings");
			},
		},
	};
}

export function dispatchResult(
	request: NestedToolDispatchRequest,
	result: NestedToolRuntimeResult,
	isError = false,
): NestedToolDispatchResult {
	return {
		toolCallId: `nested:${request.name}`,
		name: request.name,
		rawArgs: request.args,
		result,
		isError,
	};
}

export function toolExecutor(
	dispatch: (request: NestedToolDispatchRequest) => Promise<NestedToolDispatchResult>,
): ToolExecutor {
	return { dispatch };
}

export function fakeFactoryTools(execute: FactoryToolSet["read"]["execute"]): FactoryToolSet {
	return Object.fromEntries(CORE_TOOL_NAMES.map((name) => [name, { execute }])) as FactoryToolSet;
}

export async function nextTurn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}
