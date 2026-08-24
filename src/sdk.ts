// Prompt SDK is the model-facing contract. Keep it lexicographic and byte-stable.

import { CORE_TOOL_NAMES, type CoreToolName } from "./config.ts";

const BINDING_SIGNATURES = Object.freeze({
	bash: "await tools.bash({ command, timeout? })",
	edit: "await tools.edit({ path, edits })",
	find: "await tools.find({ pattern, path?, limit? })",
	grep: "await tools.grep({ pattern, path?, glob?, ignoreCase?, literal?, context?, limit? })",
	ls: "await tools.ls({ path?, limit? })",
	read: "await tools.read({ path, offset?, limit? })",
	write: "await tools.write({ path, content })",
} as const satisfies Record<CoreToolName, string>);

const SDK_HEADER = `tools:sdk
Call core tools only from a ptc program. The code argument is the body of an async function.
Top-level await and return are legal. Use erasable TypeScript only.
Successful bindings resolve to canonical JSON. Failed bindings reject ToolCallError(toolName, message).
Promise.all may overlap read, grep, find, and ls. bash, edit, and write drain the pool and run alone.
Load skills with tools.read({ path }), not a native read call. /skill:name still works.
`;

export function renderSdkPrompt(): string {
	const lines = CORE_TOOL_NAMES.map((name) => BINDING_SIGNATURES[name]);
	return `${SDK_HEADER}${lines.join("\n")}\n`;
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
