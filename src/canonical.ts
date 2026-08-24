// Programs consume canonical JSON, not Native cards. Failures stay exceptions.

import type { CoreToolName } from "./config.ts";
import { type JsonValue, snapshotJsonValue } from "./json.ts";

const DEFAULT_BASH_EXIT_CODE = 0;
const FAILED_DISPATCH_MESSAGE = "tool failed";

export type FactoryContentBlock = {
	type: string;
	text?: string;
};

export type FactoryResult = {
	content: readonly FactoryContentBlock[];
	details?: unknown;
	isError?: boolean;
};

export class ToolCallError extends Error {
	readonly toolName: string;

	constructor(toolName: string, message: string) {
		super(message);
		this.name = "ToolCallError";
		this.toolName = toolName;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function textFromContent(content: readonly FactoryContentBlock[]): string {
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("");
}

export function toCanonicalValue(name: CoreToolName, result: FactoryResult): JsonValue {
	const text = textFromContent(result.content);
	if (result.isError) {
		throw new ToolCallError(name, text || FAILED_DISPATCH_MESSAGE);
	}
	const details = isRecord(result.details) ? result.details : {};
	switch (name) {
		case "bash": {
			const exitCode =
				typeof details.exitCode === "number" ? details.exitCode : DEFAULT_BASH_EXIT_CODE;
			return snapshotJsonValue({ ...details, output: text, exitCode });
		}
		case "edit":
		case "write":
			return snapshotJsonValue({ ...details, ok: true });
		case "find":
		case "grep":
		case "ls":
		case "read":
			return snapshotJsonValue({ ...details, text });
		default: {
			const _never: never = name;
			throw new Error(`unhandled core tool: ${_never}`);
		}
	}
}
