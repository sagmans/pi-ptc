// Host side of tools.*: factory execute stays off the model transcript.

import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";

import { type FactoryResult, ToolCallError, toCanonicalValue } from "./canonical.ts";
import {
	CORE_TOOL_NAMES,
	type CoreToolName,
	DISPATCH_EVENT,
	DISPATCH_LOG_TYPE,
	isExclusiveToolName,
} from "./config.ts";
import { type JsonValue, snapshotJsonValue } from "./json.ts";
import type { BindingFn } from "./runtime.ts";
import type { Scheduler } from "./scheduler.ts";

export type DispatchLogEntry = {
	customType: typeof DISPATCH_LOG_TYPE;
	name: CoreToolName;
	args: JsonValue;
	isError: boolean;
};

export type FactoryExecutor = (
	name: CoreToolName,
	args: JsonValue,
	signal?: AbortSignal,
) => Promise<FactoryResult>;

export type CoreBindings = Record<CoreToolName, BindingFn>;

const CALL_ID_PREFIX = "ptc";

export function createOfficialExecutor(cwd: string, signal?: AbortSignal): FactoryExecutor {
	const tools = {
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		find: createFindTool(cwd),
		grep: createGrepTool(cwd),
		ls: createLsTool(cwd),
		read: createReadTool(cwd),
		write: createWriteTool(cwd),
	};
	let nextId = 1;
	return async (name, args, dispatchSignal) => {
		const tool = tools[name] as {
			execute: (
				toolCallId: string,
				params: JsonValue,
				signal?: AbortSignal,
			) => Promise<FactoryResult>;
		};
		const result = await tool.execute(
			`${CALL_ID_PREFIX}:${name}:${nextId}`,
			args,
			dispatchSignal ?? signal,
		);
		nextId += 1;
		return result;
	};
}

export function createCoreBindings(input: {
	execute: FactoryExecutor;
	scheduler: Scheduler;
	signal?: AbortSignal;
	appendLog?: (entry: DispatchLogEntry) => void;
	emit?: (name: string, payload: unknown) => void;
}): CoreBindings {
	const bindings = Object.create(null) as CoreBindings;
	for (const name of CORE_TOOL_NAMES) {
		bindings[name] = async (rawArgs) => {
			const args = snapshotJsonValue(rawArgs);
			const kind = isExclusiveToolName(name) ? "exclusive" : "parallel";
			return await input.scheduler.run(kind, async () => {
				let isError = false;
				try {
					const result = await input.execute(name, args, input.signal);
					const value = toCanonicalValue(name, result);
					input.appendLog?.({ customType: DISPATCH_LOG_TYPE, name, args, isError });
					input.emit?.(DISPATCH_EVENT, { name, args, isError });
					return value;
				} catch (error) {
					isError = true;
					input.appendLog?.({ customType: DISPATCH_LOG_TYPE, name, args, isError });
					input.emit?.(DISPATCH_EVENT, { name, args, isError });
					if (error instanceof ToolCallError) throw error;
					throw new ToolCallError(name, error instanceof Error ? error.message : String(error));
				}
			});
		};
	}
	return bindings;
}
