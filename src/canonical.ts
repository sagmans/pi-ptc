// Programs consume canonical JSON, not Native cards. Failures stay exceptions.

import { type CoreToolName, isCoreToolName } from "./config.ts";
import { type JsonValue, snapshotJsonValue } from "./json.ts";

const DEFAULT_BASH_EXIT_CODE = 0;
const FAILED_DISPATCH_MESSAGE = "tool failed";

export type FactoryContentBlock = {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
};

export type FactoryResult = {
	content: readonly FactoryContentBlock[];
	details?: unknown;
	isError?: boolean;
};

export type CanonicalContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export class ToolCallError extends Error {
	readonly toolName: string;

	constructor(toolName: string, message: string) {
		super(message);
		this.name = "ToolCallError";
		this.toolName = toolName;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	try {
		return !Array.isArray(value);
	} catch {
		return false;
	}
}

function readProperty(
	value: Record<string, unknown>,
	key: string,
): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: Reflect.get(value, key) };
	} catch {
		return { ok: false };
	}
}

function projectContentBlock(value: unknown): CanonicalContentBlock | undefined {
	if (!isRecord(value)) return undefined;
	const type = readProperty(value, "type");
	if (!type.ok) return undefined;
	if (type.value === "text") {
		const text = readProperty(value, "text");
		return text.ok && typeof text.value === "string"
			? { type: "text", text: text.value }
			: undefined;
	}
	if (type.value !== "image") return undefined;
	const data = readProperty(value, "data");
	const mimeType = readProperty(value, "mimeType");
	return data.ok &&
		typeof data.value === "string" &&
		mimeType.ok &&
		typeof mimeType.value === "string"
		? { type: "image", data: data.value, mimeType: mimeType.value }
		: undefined;
}

export function projectCanonicalContent(value: unknown): CanonicalContentBlock[] {
	try {
		if (!Array.isArray(value)) return [];
	} catch {
		return [];
	}
	const content: CanonicalContentBlock[] = [];
	let length: number;
	try {
		length = value.length;
	} catch {
		return content;
	}
	for (let index = 0; index < length; index += 1) {
		let rawBlock: unknown;
		try {
			rawBlock = Reflect.get(value, index);
		} catch {
			continue;
		}
		const block = projectContentBlock(rawBlock);
		if (block) content.push(block);
	}
	return content;
}

export function textFromContent(content: readonly FactoryContentBlock[]): string {
	return projectCanonicalContent(content)
		.filter(
			(block): block is Extract<CanonicalContentBlock, { type: "text" }> => block.type === "text",
		)
		.map((block) => block.text)
		.join("");
}

function snapshotOptionalProperty(
	result: Record<string, unknown>,
	key: "details" | "usage",
): JsonValue | undefined {
	const property = readProperty(result, key);
	if (!property.ok || property.value === undefined) return undefined;
	try {
		return snapshotJsonValue(property.value);
	} catch {
		return undefined;
	}
}

export function toToolCanonicalValue(
	name: string,
	resultValue: unknown,
	isError: boolean,
): JsonValue {
	const result = isRecord(resultValue) ? resultValue : {};
	const rawContent = readProperty(result, "content");
	const content = projectCanonicalContent(rawContent.ok ? rawContent.value : undefined);
	const text = textFromContent(content);
	if (isError) throw new ToolCallError(name, text || FAILED_DISPATCH_MESSAGE);
	if (isCoreToolName(name)) {
		const details = readProperty(result, "details");
		return toCanonicalValue(name, {
			content,
			details: details.ok ? details.value : undefined,
		});
	}
	const envelope: {
		text: string;
		content: CanonicalContentBlock[];
		details?: JsonValue;
		usage?: JsonValue;
	} = {
		text,
		content,
	};
	const details = snapshotOptionalProperty(result, "details");
	if (details !== undefined) envelope.details = details;
	const usage = snapshotOptionalProperty(result, "usage");
	if (usage !== undefined) envelope.usage = usage;
	return envelope;
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
