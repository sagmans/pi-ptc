import type { LargeScaleTextEditingResult } from "./large-scale-text-editing.d.mts";
import type { EvalCondition, EvalRun } from "./metrics.d.mts";

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

export function loadCaseDefinition(
	name: string,
	casesDirectory: string | URL,
): Promise<CaseDefinition>;
export function materializeCase(
	definition: CaseDefinition,
	directory: string,
	condition: EvalCondition,
): Promise<void>;
export function judgeCaseResult(
	definition: CaseDefinition,
	finalText: string | undefined,
	workspaceDirectory?: string,
): Promise<LargeScaleTextEditingResult>;
export function buildDecoyToolList(count: number): string[];
export function executeRun(options: {
	run: EvalRun;
	config: Record<string, unknown> & { catalogDecoyCount: number };
	definition: CaseDefinition;
	workspaceDirectory: string;
	sessionDirectory: string;
	rpcLogPath: string;
	packageEntryPath?: string;
	budgetCheck?: (currentCostUsd: number) => boolean;
}): Promise<Record<string, unknown>>;
