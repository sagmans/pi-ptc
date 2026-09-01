// Prompt SDK is the model-facing contract. Keep it lexicographic and byte-stable.

import { type CoreToolName, isCoreToolName } from "./config.ts";
import {
	renderSafeJsonStringLiteral,
	SCHEMA_SIGNATURE_FALLBACK,
	schemaToTypeScriptSignature,
} from "./schema-signature.ts";
import type { ToolCatalogEntry } from "./tool-catalog.ts";

const BINDING_SIGNATURES = Object.freeze({
	bash: "await tools.bash({ command, timeout? })",
	edit: "await tools.edit({ path, edits })",
	find: "await tools.find({ pattern, path?, limit? })",
	grep: "await tools.grep({ pattern, path?, glob?, ignoreCase?, literal?, context?, limit? })",
	ls: "await tools.ls({ path?, limit? })",
	read: "await tools.read({ path, offset?, limit? })",
	write: "await tools.write({ path, content })",
} as const satisfies Record<CoreToolName, string>);

const ACTIVE_SDK_HEADER = `tools:sdk
Call active runtime tools only from a ptc program. The code argument is the body of an async function.
Top-level await and return are legal. Use erasable TypeScript only.
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
		return { name: entry.name, line: BINDING_SIGNATURES[entry.name] };
	}
	let signature = SCHEMA_SIGNATURE_FALLBACK;
	try {
		signature = schemaToTypeScriptSignature(entry.executable.parameters);
	} catch {}
	const reference = ASCII_IDENTIFIER_PATTERN.test(entry.name)
		? `tools.${entry.name}`
		: `tools[${renderSafeJsonStringLiteral(entry.name)}]`;
	return { name: entry.name, line: `await ${reference}(${signature})` };
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
