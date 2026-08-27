import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";

import type { CoreToolName } from "./config.ts";
import type { FactoryExecutor, FactoryToolSet } from "./dispatch-contract.ts";

const CALL_ID_PREFIX = "ptc";
const OPERATION_ABORTED_MESSAGE = "Operation aborted";
const NATIVE_ABORT_DRAINING_TOOL_NAMES = new Set<CoreToolName>(["bash", "edit", "write"]);

export function createFactoryExecutor(
	tools: FactoryToolSet,
	signal?: AbortSignal,
): FactoryExecutor {
	let nextId = 1;
	return async (name, args, dispatchSignal, onUpdate) => {
		const id = nextId;
		nextId += 1;
		const invocationSignal = dispatchSignal ?? signal;
		if (invocationSignal?.aborted) throw new Error(OPERATION_ABORTED_MESSAGE);
		// Pi 0.84.3 read/list/search promises can reject before owned I/O exits, so drain them naturally.
		const nativeSignal = NATIVE_ABORT_DRAINING_TOOL_NAMES.has(name) ? invocationSignal : undefined;
		try {
			const result = await tools[name].execute(
				`${CALL_ID_PREFIX}:${name}:${id}`,
				args,
				nativeSignal,
				onUpdate,
			);
			if (nativeSignal === undefined && invocationSignal?.aborted) {
				throw new Error(OPERATION_ABORTED_MESSAGE);
			}
			return result;
		} catch (error) {
			if (nativeSignal === undefined && invocationSignal?.aborted) {
				throw new Error(OPERATION_ABORTED_MESSAGE);
			}
			throw error;
		}
	};
}

export function createOfficialExecutor(cwd: string): FactoryExecutor {
	const tools = {
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		find: createFindTool(cwd),
		grep: createGrepTool(cwd),
		ls: createLsTool(cwd),
		read: createReadTool(cwd),
		write: createWriteTool(cwd),
	} as unknown as FactoryToolSet;
	return createFactoryExecutor(tools);
}
