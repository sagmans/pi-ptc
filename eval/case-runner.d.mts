import type { EvalCondition, EvalRun } from "./metrics.d.mts";

export type CaseDefinition = {
	name: string;
	description: string;
	tools: string[];
	prompt: string;
	files: Array<{ path: string; content: string }>;
	expected: Record<string, unknown>;
	path?: string;
};

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
): { correct: boolean; reason: string };
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
