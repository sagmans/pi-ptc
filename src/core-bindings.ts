import type { FactoryResult } from "./canonical.ts";
import { CORE_TOOL_NAMES, isCoreToolName } from "./config.ts";
import type {
	CoreBindings,
	DispatchLogEntry,
	DispatchProgress,
	FactoryExecutor,
} from "./dispatch-contract.ts";
import type { Scheduler } from "./scheduler.ts";
import { createToolBindings, type ToolBindingReporting } from "./tool-bindings.ts";
import type { ToolCatalogEntry } from "./tool-catalog.ts";
import type {
	NestedToolDispatchRequest,
	NestedToolDispatchResult,
	NestedToolRuntimeResult,
	ToolExecutor,
} from "./tool-executor.ts";

const CORE_COMPATIBILITY_CALL_ID_PREFIX = "ptc-core-compatibility:";
const CORE_CATALOG_EXECUTION_MESSAGE = "core compatibility catalog entries are metadata only";

const CORE_CATALOG_SNAPSHOT = Object.freeze(
	CORE_TOOL_NAMES.map(
		(name): ToolCatalogEntry => ({
			name,
			definition: undefined,
			executable: {
				parameters: {},
				async execute() {
					throw new Error(CORE_CATALOG_EXECUTION_MESSAGE);
				},
			},
		}),
	),
);

type CoreBindingsInput = {
	execute: FactoryExecutor;
	scheduler: Scheduler;
	appendLog?: (entry: DispatchLogEntry) => void;
	emit?: (name: string, payload: unknown) => void;
	acceptSideEffects?: () => boolean;
	reportDispatch?: (progress: DispatchProgress) => void;
};

export function createCoreBindings(input: CoreBindingsInput): CoreBindings {
	const reporting: ToolBindingReporting = {
		...(input.appendLog ? { appendLog: input.appendLog } : {}),
		...(input.emit ? { emit: input.emit } : {}),
		...(input.acceptSideEffects ? { acceptSideEffects: input.acceptSideEffects } : {}),
		...(input.reportDispatch ? { reportDispatch: input.reportDispatch } : {}),
	};
	return createToolBindings(
		CORE_CATALOG_SNAPSHOT,
		createCompatibilityExecutor(input.execute),
		input.scheduler,
		reporting,
	) as CoreBindings;
}

function createCompatibilityExecutor(execute: FactoryExecutor): ToolExecutor {
	return {
		async dispatch(request: NestedToolDispatchRequest): Promise<NestedToolDispatchResult> {
			if (!isCoreToolName(request.name)) {
				throw new Error(`unhandled core tool: ${request.name}`);
			}
			const result = await execute(
				request.name,
				request.args as Parameters<FactoryExecutor>[1],
				request.signal,
				(partial) => request.onUpdate?.(partial),
			);
			return compatibilityDispatchResult(request, result);
		},
	};
}

function compatibilityDispatchResult(
	request: NestedToolDispatchRequest,
	result: FactoryResult,
): NestedToolDispatchResult {
	return {
		toolCallId: `${CORE_COMPATIBILITY_CALL_ID_PREFIX}${request.name}`,
		name: request.name,
		rawArgs: request.args,
		result: result as NestedToolRuntimeResult,
		isError: result.isError === true,
	};
}
