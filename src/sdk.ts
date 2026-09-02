// Prompt SDK is the model-facing contract. Keep it lexicographic and byte-stable.

import { type CoreToolName, isCoreToolName } from "./config.ts";
import {
	renderSafeJsonStringLiteral,
	SCHEMA_SIGNATURE_FALLBACK,
	schemaToTypeScriptSignature,
} from "./schema-signature.ts";
import type { ToolCatalogEntry } from "./tool-catalog.ts";

const BINDING_SIGNATURES = Object.freeze({
	bash: "{ command: string; timeout?: number }",
	edit: "{ path: string; edits: { oldText: string; newText: string }[] }",
	find: "{ pattern: string; path?: string; limit?: number }",
	grep: "{ pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }",
	ls: "{ path?: string; limit?: number }",
	read: "{ path: string; offset?: number; limit?: number }",
	write: "{ path: string; content: string }",
} as const satisfies Record<CoreToolName, string>);

const ACTIVE_SDK_HEADER = `tools:sdk
Call active runtime tools only from a ptc program. tools is injected; do not import it.
The code argument is an async function body: no Markdown fences, imports, exports, JSX, enums, namespaces, or decorators.
Top-level await and return are legal. Prefer plain JavaScript; use erasable TypeScript only when needed.
Each binding takes one argument matching its schema below. Schemas are reference notation, not copyable calls; pass concrete values.
Binding arguments and returned results must be lossless JSON: null, booleans, finite numbers except -0, strings, dense arrays, and plain objects.
Omit undefined fields or replace them with null. Convert BigInt, Date, Map, Set, class instances, and other values before crossing a boundary.
Await every dispatch. Use Promise.all only for independent calls. Project large results before returning them.
Successful bindings resolve to canonical JSON. Failed tool calls reject ToolCallError(toolName, message).
ToolResultDeliveryError means execution may have succeeded; retryUnsafe is true because retry may repeat effects.
Keep logs and return values concise; intermediate binding values stay model-hidden.
Tool calls follow active runtime scheduling modes.
`;
const SKILL_COMMAND_GUIDANCE = "/skill:name still works.\n";
const READ_SKILL_GUIDANCE =
	"Load skills with tools.read({ path }), not a native read call. /skill:name still works.\n";
const ASCII_IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

type SdkToolLine = {
	name: string;
	line: string;
};

export function renderSdkPrompt(catalog: readonly ToolCatalogEntry[]): string {
	const lines = catalog.map(renderCatalogToolLine).sort(compareToolLines);
	const guidance = catalog.some((entry) => entry.name === "read")
		? READ_SKILL_GUIDANCE
		: SKILL_COMMAND_GUIDANCE;
	return `${ACTIVE_SDK_HEADER}${guidance}${lines.map(({ line }) => line).join("\n")}\n`;
}

function renderCatalogToolLine(entry: ToolCatalogEntry): SdkToolLine {
	if (isCoreToolName(entry.name)) {
		return {
			name: entry.name,
			line: `tools.${entry.name} arguments: ${BINDING_SIGNATURES[entry.name]}`,
		};
	}
	let signature = SCHEMA_SIGNATURE_FALLBACK;
	try {
		signature = schemaToTypeScriptSignature(entry.executable.parameters);
	} catch {}
	const reference = ASCII_IDENTIFIER_PATTERN.test(entry.name)
		? `tools.${entry.name}`
		: `tools[${renderSafeJsonStringLiteral(entry.name)}]`;
	return { name: entry.name, line: `${reference} arguments: ${signature}` };
}

function compareToolLines(left: SdkToolLine, right: SdkToolLine): number {
	if (left.name < right.name) return -1;
	if (left.name > right.name) return 1;
	if (left.line < right.line) return -1;
	if (left.line > right.line) return 1;
	return 0;
}

export type SkillPromptInput = {
	name: string;
	description: string;
	filePath: string;
	disableModelInvocation?: boolean;
};

export function renderSkillsPrompt(skills: readonly SkillPromptInput[]): string {
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	if (visible.length === 0) return "";
	const lines = [
		"",
		"The following skills provide specialized instructions for specific tasks.",
		"Load a skill file with tools.read when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory.",
		"",
		"<available_skills>",
	];
	for (const skill of visible) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return `\n${lines.join("\n")}`;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}
