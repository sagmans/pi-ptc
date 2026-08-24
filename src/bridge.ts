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

export type DispatchStatus = "start" | "ok" | "err";

export type DispatchProgress = {
	name: CoreToolName;
	args: JsonValue;
	status: DispatchStatus;
};

const DISPATCH_START_MARK = "…";
const DISPATCH_OK_MARK = "ok";
const DISPATCH_ERR_MARK = "err";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function dispatchTarget(name: CoreToolName, args: JsonValue): string {
	if (!isRecord(args)) return "";
	if (name === "bash") {
		return typeof args.command === "string" ? args.command : "";
	}
	if (name === "grep" || name === "find") {
		if (typeof args.path === "string") return args.path;
		return typeof args.pattern === "string" ? args.pattern : "";
	}
	return typeof args.path === "string" ? args.path : "";
}

export function formatDispatchLine(progress: DispatchProgress): string {
	let mark: string;
	switch (progress.status) {
		case "start":
			mark = DISPATCH_START_MARK;
			break;
		case "ok":
			mark = DISPATCH_OK_MARK;
			break;
		case "err":
			mark = DISPATCH_ERR_MARK;
			break;
		default: {
			const _never: never = progress.status;
			throw new Error(`unhandled dispatch status: ${_never}`);
		}
	}
	const target = dispatchTarget(progress.name, progress.args);
	return target.length > 0 ? `${progress.name} ${mark} ${target}` : `${progress.name} ${mark}`;
}

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
	reportDispatch?: (progress: DispatchProgress) => void;
}): CoreBindings {
	const bindings = Object.create(null) as CoreBindings;
	for (const name of CORE_TOOL_NAMES) {
		bindings[name] = async (rawArgs) => {
			const args = snapshotJsonValue(rawArgs);
			const kind = isExclusiveToolName(name) ? "exclusive" : "parallel";
			return await input.scheduler.run(kind, async () => {
				let isError = false;
				input.reportDispatch?.({ name, args, status: "start" });
				try {
					const result = await input.execute(name, args, input.signal);
					const value = toCanonicalValue(name, result);
					input.appendLog?.({ customType: DISPATCH_LOG_TYPE, name, args, isError });
					input.emit?.(DISPATCH_EVENT, { name, args, isError });
					input.reportDispatch?.({ name, args, status: "ok" });
					return value;
				} catch (error) {
					isError = true;
					input.appendLog?.({ customType: DISPATCH_LOG_TYPE, name, args, isError });
					input.emit?.(DISPATCH_EVENT, { name, args, isError });
					input.reportDispatch?.({ name, args, status: "err" });
					if (error instanceof ToolCallError) throw error;
					throw new ToolCallError(name, error instanceof Error ? error.message : String(error));
				}
			});
		};
	}
	return bindings;
}
