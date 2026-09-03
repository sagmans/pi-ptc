export type EvalModelConfig = {
	provider: string;
	model: string;
	thinking: string;
};

export type EvalCondition = "absent" | "native" | "both" | "code";

export type EvalRun = {
	model: EvalModelConfig;
	case: string;
	condition: EvalCondition;
	repetition: number;
};

export type ValidatedConfig = {
	ok: boolean;
	errors: string[];
	value: {
		models: EvalModelConfig[];
		conditions: EvalCondition[];
		repetitions: number;
		expectedRuns: number;
		maxCostUsd: number;
		forbiddenProviders: string[];
		catalogDecoyCount: number;
		cases: string[];
	};
};

export function validateEvalConfig(config: unknown): ValidatedConfig;
export function runKey(run: EvalRun): string;
export function buildRunMatrix(config: ValidatedConfig["value"]): EvalRun[];
export function extractJudgeResult(text: string): { ok: boolean; value?: unknown; reason?: string };
export function extractMetricsFromSession(input: {
	entries: unknown[];
	stats?: {
		tokens?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			total?: number;
		};
		cost?: number;
	};
}): {
	assistantTurns: number;
	visibleToolCalls: number;
	ptcCalls: number;
	nativeToolCalls: number;
	nestedDispatches: number;
	providerRequestBytes: number[];
	visibleToolResultBytes: number;
	toolErrors: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUsd: number;
	strategy: "ptc" | "native" | "mixed" | "none";
};
export function startGateAllowsRun(observedCostUsd: number, maxCostUsd: number): boolean;
export function shouldAbortInflight(
	observedCostUsd: number,
	currentRunCostUsd: number,
	maxCostUsd: number,
): boolean;
export function summarizeRuns(runs: Array<Record<string, unknown>>): {
	completed: number;
	totalCostUsd: number;
	failures: Array<{ key: string; reason: string }>;
	conditions: Record<string, Record<string, unknown>>;
	note: string;
};
