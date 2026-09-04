// Case materialization and deterministic judging.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalCondition } from "./metrics.ts";
import {
	judgeLargeScaleTextEditing,
	type LargeScaleTextEditingResult,
	materializeLargeScaleTextEditing,
} from "./terminal-bench/large-scale-text-editing.ts";

const EXACT_RESULT_JUDGE = "exact-result";
const LARGE_SCALE_TEXT_EDITING_JUDGE = "large-scale-text-editing";
const EVAL_RESULT_PATTERN = /(?:^|\n)EVAL_RESULT (\{.*\})(?=$|\n)/g;

type CaseBase = {
	name: string;
	description: string;
	tools: string[];
	prompt: string;
	path?: string;
	settleTimeoutMs?: number;
};

export type ExactResultCaseDefinition = CaseBase & {
	judge?: "exact-result";
	files: Array<{ path: string; content: string }>;
	expected: Record<string, unknown>;
};

export type LargeScaleTextEditingCaseDefinition = CaseBase & {
	judge: "large-scale-text-editing";
	rowCount: number;
	files: [];
	provenance: {
		suite: string;
		task: string;
		source: string;
		digest: string;
		license: "Apache-2.0";
	};
};

export type CaseDefinition = ExactResultCaseDefinition | LargeScaleTextEditingCaseDefinition;

export function extractJudgeResult(text: string): {
	ok: boolean;
	value?: unknown;
	reason?: string;
} {
	EVAL_RESULT_PATTERN.lastIndex = 0;
	const matches = [...text.matchAll(EVAL_RESULT_PATTERN)];
	const last = matches[matches.length - 1];
	if (!last) {
		return { ok: false, reason: "no EVAL_RESULT JSON line found" };
	}
	try {
		return { ok: true, value: JSON.parse(last[1]) };
	} catch (error) {
		return { ok: false, reason: `EVAL_RESULT line is not valid JSON: ${error}` };
	}
}

export async function loadCaseDefinition(
	name: string,
	casesDirectory: string | URL,
): Promise<CaseDefinition & { path: string }> {
	const path = join(
		typeof casesDirectory === "string" ? casesDirectory : fileURLToPath(casesDirectory),
		`${name}.json`,
	);
	return { ...(JSON.parse(await readFile(path, "utf8")) as CaseDefinition), path };
}

export async function materializeCase(
	definition: CaseDefinition,
	directory: string,
	_condition: EvalCondition,
): Promise<void> {
	if (definition.judge === LARGE_SCALE_TEXT_EDITING_JUDGE) {
		await materializeLargeScaleTextEditing(directory, definition.rowCount);
	} else if (definition.judge === undefined || definition.judge === EXACT_RESULT_JUDGE) {
		for (const file of definition.files) {
			const target = join(directory, file.path);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, file.content, "utf8");
		}
	} else {
		throw new Error(`unsupported case judge: ${definition.judge}`);
	}
}

export async function judgeCaseResult(
	definition: CaseDefinition,
	finalText: string | undefined,
	workspaceDirectory?: string,
): Promise<LargeScaleTextEditingResult> {
	if (definition.judge === LARGE_SCALE_TEXT_EDITING_JUDGE) {
		if (workspaceDirectory === undefined) {
			throw new TypeError("workspaceDirectory is required for this case judge");
		}
		return judgeLargeScaleTextEditing(workspaceDirectory, definition.rowCount);
	}
	if (definition.judge !== undefined && definition.judge !== EXACT_RESULT_JUDGE) {
		throw new Error(`unsupported case judge: ${definition.judge}`);
	}
	const judged = extractJudgeResult(finalText ?? "");
	if (!judged.ok) return { correct: false, reason: judged.reason ?? "" };
	const expected = JSON.stringify(definition.expected);
	const actual = JSON.stringify(judged.value);
	if (expected !== actual) {
		return { correct: false, reason: `expected ${expected} but got ${actual}` };
	}
	return { correct: true, reason: "exact match" };
}
