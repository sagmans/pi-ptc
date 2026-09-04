// Pure parsers and aggregators for the PTC evaluation. No Pi process, no I/O.

export type EvalModelConfig = {
	provider: string;
	model: string;
	thinking: string;
};

export type EvalCondition = "absent" | "code";

export type EvalRun = {
	model: EvalModelConfig;
	case: string;
	condition: EvalCondition;
	repetition: number;
};

export type EvalConfig = {
	models: EvalModelConfig[];
	conditions: EvalCondition[];
	repetitions: number;
	expectedRuns: number;
	maxCostUsd: number;
	forbiddenProviders: string[];
	cases: string[];
};

export type ValidatedConfig = {
	ok: boolean;
	errors: string[];
	value: EvalConfig;
};

export type SessionStats = {
	tokens?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
	cost?: number;
	sessionFile?: string;
};

type SessionMessage = {
	role?: string;
	content?: unknown[];
	isError?: boolean;
} & Record<string, unknown>;

type SessionEntry = Record<string, unknown>;

export type SessionMetrics = {
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

export type SummaryRow = {
	count: number;
	correct: number;
	medianAssistantTurns: number;
	medianProviderRequestBytes: number;
	medianVisibleToolResultBytes: number;
	medianTotalTokens: number;
	medianCostUsd: number;
	[key: string]: unknown;
};

export type RunSummary = {
	completed: number;
	totalCostUsd: number;
	failures: Array<{ key: string; reason: string }>;
	conditions: Record<string, SummaryRow>;
	note: string;
};

export type EvaluatedRun = {
	key: string;
	condition: EvalCondition;
	repetition: number;
	correct: boolean;
	reason: string;
	assistantTurns: number;
	providerRequestBytes: number[];
	visibleToolResultBytes: number;
	totalTokens: number;
	costUsd: number;
	wallTimeMs: number;
} & Record<string, unknown>;

export const CONDITIONS: readonly EvalCondition[] = ["absent", "code"];
const PTC_TOOL_NAME = "ptc";
const DISPATCH_ENTRY_TYPE = "ptc-dispatch";
const PROVIDER_BYTES_ENTRY_TYPE = "eval-provider-request-bytes";
const CASE_SELECTION_ERROR = "case must match one of the configured cases";

export function validateEvalConfig(config: unknown): ValidatedConfig {
	const input = config as Partial<EvalConfig>;
	const errors: string[] = [];
	const seenModels = new Set<string>();
	if (!Array.isArray(input.models) || input.models.length === 0) {
		errors.push("models must be a non-empty array");
	}
	const forbidden = Array.isArray(input.forbiddenProviders) ? input.forbiddenProviders : [];
	for (const model of Array.isArray(input.models) ? input.models : []) {
		const key = `${model?.provider}/${model?.model}/${model?.thinking ?? ""}`;
		if (seenModels.has(key)) errors.push(`duplicate model: ${key}`);
		seenModels.add(key);
		if (forbidden.includes(model?.provider)) {
			errors.push(`forbidden provider: ${model?.provider}`);
		}
	}
	const conditions = Array.isArray(input.conditions) ? input.conditions : [];
	if (
		conditions.length === 0 ||
		!conditions.every((condition) => (CONDITIONS as readonly string[]).includes(condition)) ||
		new Set(conditions).size !== conditions.length
	) {
		errors.push(`conditions must be a non-empty unique subset of ${JSON.stringify(CONDITIONS)}`);
	}
	if (!Number.isFinite(input.repetitions) || (input.repetitions ?? 0) < 1) {
		errors.push("repetitions must be a positive number");
	}
	if (!Number.isFinite(input.maxCostUsd) || (input.maxCostUsd ?? 0) <= 0) {
		errors.push("maxCostUsd must be a positive number");
	}
	if (!Array.isArray(input.cases) || input.cases.length === 0) {
		errors.push("cases must be a non-empty array");
	}
	const expectedRuns =
		(Array.isArray(input.models) ? input.models.length : 0) *
		(Array.isArray(input.conditions) ? input.conditions.length : 0) *
		(Array.isArray(input.cases) ? input.cases.length : 0) *
		(Number.isFinite(input.repetitions) ? (input.repetitions as number) : 0);
	if (input.expectedRuns !== expectedRuns) {
		errors.push(
			`expectedRuns ${input.expectedRuns} does not match computed matrix ${expectedRuns}`,
		);
	}
	return { ok: errors.length === 0, errors, value: input as EvalConfig };
}

export function runKey(run: EvalRun): string {
	return `${run.model.provider}/${run.model.model}/${run.model.thinking}/${run.case}/${run.condition}/${run.repetition}`;
}

export function buildRunMatrix(config: EvalConfig, caseName?: string): EvalRun[] {
	if (caseName !== undefined && !config.cases.includes(caseName)) {
		throw new Error(`${CASE_SELECTION_ERROR}: ${JSON.stringify(config.cases)}`);
	}
	const cases = caseName === undefined ? config.cases : [caseName];
	const runs: EvalRun[] = [];
	for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
		const conditions =
			repetition % 2 === 1 ? [...config.conditions] : [...config.conditions].reverse();
		for (const model of config.models) {
			for (const caseName of cases) {
				for (const condition of conditions) {
					runs.push({ model, case: caseName, condition, repetition });
				}
			}
		}
	}
	return runs;
}

function messageOf(entry: SessionEntry): SessionMessage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	return typeof message === "object" && message !== null ? (message as SessionMessage) : undefined;
}

export function extractMetricsFromSession(input: {
	entries: unknown[];
	stats?: SessionStats;
}): SessionMetrics {
	let assistantTurns = 0;
	let visibleToolCalls = 0;
	let ptcCalls = 0;
	let nativeToolCalls = 0;
	let visibleToolResultBytes = 0;
	let toolErrors = 0;
	let nestedDispatches = 0;
	const providerRequestBytes: number[] = [];
	for (const entry of Array.isArray(input.entries) ? input.entries : []) {
		const record = entry as SessionEntry;
		const message = messageOf(record);
		if (!message) {
			if (record.type === "custom") {
				if (record.customType === DISPATCH_ENTRY_TYPE) nestedDispatches += 1;
				if (record.customType === PROVIDER_BYTES_ENTRY_TYPE) {
					const data = record.data;
					const bytes =
						typeof data === "object" && data !== null
							? (data as { bytes?: unknown }).bytes
							: undefined;
					if (typeof bytes === "number" && Number.isFinite(bytes)) {
						providerRequestBytes.push(bytes);
					}
				}
			}
			continue;
		}
		if (message.role === "assistant") {
			assistantTurns += 1;
			for (const block of Array.isArray(message.content) ? message.content : []) {
				const toolCall = block as { type?: string; name?: string };
				if (toolCall.type === "toolCall") {
					visibleToolCalls += 1;
					if (toolCall.name === PTC_TOOL_NAME) ptcCalls += 1;
					else nativeToolCalls += 1;
				}
			}
		}
		if (message.role === "toolResult") {
			visibleToolResultBytes += JSON.stringify(message.content ?? []).length;
			if (message.isError === true) toolErrors += 1;
		}
	}
	const tokens = input.stats?.tokens ?? {};
	const strategy =
		ptcCalls > 0 && nativeToolCalls === 0
			? "ptc"
			: nativeToolCalls > 0 && ptcCalls === 0
				? "native"
				: ptcCalls > 0 && nativeToolCalls > 0
					? "mixed"
					: "none";
	return {
		assistantTurns,
		visibleToolCalls,
		ptcCalls,
		nativeToolCalls,
		nestedDispatches,
		providerRequestBytes,
		visibleToolResultBytes,
		toolErrors,
		inputTokens: tokens.input ?? 0,
		outputTokens: tokens.output ?? 0,
		cacheReadTokens: tokens.cacheRead ?? 0,
		cacheWriteTokens: tokens.cacheWrite ?? 0,
		totalTokens: tokens.total ?? 0,
		costUsd: input.stats?.cost ?? 0,
		strategy,
	};
}

export function startGateAllowsRun(observedCostUsd: number, maxCostUsd: number): boolean {
	return observedCostUsd < maxCostUsd;
}

export function shouldAbortInflight(
	observedCostUsd: number,
	currentRunCostUsd: number,
	maxCostUsd: number,
): boolean {
	// Best-effort only: provider reporting lags, so overshoot is possible.
	return observedCostUsd + currentRunCostUsd >= maxCostUsd;
}

function median(values: number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length === 0
		? 0
		: sorted.length % 2 === 1
			? sorted[middle]
			: (sorted[middle - 1] + sorted[middle]) / 2;
}

function conditionSummary(runs: readonly EvaluatedRun[]): SummaryRow {
	return {
		count: runs.length,
		correct: runs.filter((run) => run.correct).length,
		medianAssistantTurns: median(runs.map((run) => run.assistantTurns)),
		medianProviderRequestBytes: median(
			runs.map((run) => run.providerRequestBytes.reduce((a, b) => a + b, 0)),
		),
		medianVisibleToolResultBytes: median(runs.map((run) => run.visibleToolResultBytes)),
		medianTotalTokens: median(runs.map((run) => run.totalTokens)),
		medianCostUsd: median(runs.map((run) => run.costUsd)),
		medianWallTimeMs: median(runs.map((run) => run.wallTimeMs)),
		repetitions: runs.map((run) => ({
			repetition: run.repetition,
			correct: run.correct,
			assistantTurns: run.assistantTurns,
		})),
	};
}

export function summarizeRuns(runs: readonly EvaluatedRun[]): RunSummary {
	const conditions: Record<string, SummaryRow> = {};
	for (const condition of CONDITIONS) {
		const matching = runs.filter((run) => run.condition === condition);
		if (matching.length === 0) continue;
		const summary: SummaryRow = conditionSummary(matching);
		const absent = conditions.absent;
		if (absent) {
			summary.deltaAssistantTurnsVsAbsent =
				summary.medianAssistantTurns - absent.medianAssistantTurns;
			summary.deltaProviderRequestBytesVsAbsent =
				summary.medianProviderRequestBytes - absent.medianProviderRequestBytes;
			summary.deltaVisibleToolResultBytesVsAbsent =
				summary.medianVisibleToolResultBytes - absent.medianVisibleToolResultBytes;
		}
		conditions[condition] = summary;
	}
	// Two repetitions cannot support statistical significance claims.
	return {
		completed: runs.length,
		totalCostUsd: runs.reduce((total, run) => total + run.costUsd, 0),
		failures: runs
			.filter((run) => !run.correct)
			.map((run) => ({ key: run.key, reason: run.reason })),
		conditions,
		note: "Two repetitions per cell; report deltas descriptively only.",
	};
}
