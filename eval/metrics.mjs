// Pure parsers and aggregators for the PTC evaluation. No Pi process, no I/O.

export const CONDITIONS = ["absent", "native", "both", "code"];
const EVAL_RESULT_PATTERN = /(?:^|\n)EVAL_RESULT (\{.*\})(?=$|\n)/g;
const PTC_TOOL_NAME = "ptc";
const DISPATCH_ENTRY_TYPE = "ptc-dispatch";
const PROVIDER_BYTES_ENTRY_TYPE = "eval-provider-request-bytes";

export function validateEvalConfig(config) {
	const errors = [];
	const seenModels = new Set();
	if (!Array.isArray(config.models) || config.models.length === 0) {
		errors.push("models must be a non-empty array");
	}
	const forbidden = Array.isArray(config.forbiddenProviders) ? config.forbiddenProviders : [];
	for (const model of Array.isArray(config.models) ? config.models : []) {
		const key = `${model?.provider}/${model?.model}`;
		if (seenModels.has(key)) errors.push(`duplicate model: ${key}`);
		seenModels.add(key);
		if (forbidden.includes(model?.provider)) {
			errors.push(`forbidden provider: ${model?.provider}`);
		}
	}
	if (
		!Array.isArray(config.conditions) ||
		JSON.stringify(config.conditions) !== JSON.stringify(CONDITIONS)
	) {
		errors.push(`conditions must be exactly ${JSON.stringify(CONDITIONS)}`);
	}
	if (!Number.isFinite(config.repetitions) || config.repetitions < 1) {
		errors.push("repetitions must be a positive number");
	}
	if (!Number.isFinite(config.maxCostUsd) || config.maxCostUsd <= 0) {
		errors.push("maxCostUsd must be a positive number");
	}
	if (!Number.isFinite(config.catalogDecoyCount) || config.catalogDecoyCount < 1) {
		errors.push("catalogDecoyCount must be a positive number");
	}
	if (!Array.isArray(config.cases) || config.cases.length === 0) {
		errors.push("cases must be a non-empty array");
	}
	const expectedRuns =
		(Array.isArray(config.models) ? config.models.length : 0) *
		(Array.isArray(config.conditions) ? config.conditions.length : 0) *
		(Array.isArray(config.cases) ? config.cases.length : 0) *
		(Number.isFinite(config.repetitions) ? config.repetitions : 0);
	if (config.expectedRuns !== expectedRuns) {
		errors.push(
			`expectedRuns ${config.expectedRuns} does not match computed matrix ${expectedRuns}`,
		);
	}
	return { ok: errors.length === 0, errors, value: config };
}

export function runKey(run) {
	return `${run.model.provider}/${run.model.model}/${run.case}/${run.condition}/${run.repetition}`;
}

export function buildRunMatrix(config) {
	const runs = [];
	for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
		const conditions =
			repetition % 2 === 1 ? [...config.conditions] : [...config.conditions].reverse();
		for (const model of config.models) {
			for (const caseName of config.cases) {
				for (const condition of conditions) {
					runs.push({ model, case: caseName, condition, repetition });
				}
			}
		}
	}
	return runs;
}

export function extractJudgeResult(text) {
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

function messageOf(entry) {
	return entry?.type === "message" && entry.message ? entry.message : undefined;
}

export function extractMetricsFromSession({ entries, stats }) {
	let assistantTurns = 0;
	let visibleToolCalls = 0;
	let ptcCalls = 0;
	let nativeToolCalls = 0;
	let visibleToolResultBytes = 0;
	let toolErrors = 0;
	let nestedDispatches = 0;
	const providerRequestBytes = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		const message = messageOf(entry);
		if (!message) {
			if (entry?.type === "custom") {
				if (entry.customType === DISPATCH_ENTRY_TYPE) nestedDispatches += 1;
				if (entry.customType === PROVIDER_BYTES_ENTRY_TYPE && Number.isFinite(entry?.data?.bytes)) {
					providerRequestBytes.push(entry.data.bytes);
				}
			}
			continue;
		}
		if (message.role === "assistant") {
			assistantTurns += 1;
			for (const block of Array.isArray(message.content) ? message.content : []) {
				if (block?.type === "toolCall") {
					visibleToolCalls += 1;
					if (block.name === PTC_TOOL_NAME) ptcCalls += 1;
					else nativeToolCalls += 1;
				}
			}
		}
		if (message.role === "toolResult") {
			visibleToolResultBytes += JSON.stringify(message.content ?? []).length;
			if (message.isError === true) toolErrors += 1;
		}
	}
	const tokens = stats?.tokens ?? {};
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
		costUsd: stats?.cost ?? 0,
		strategy,
	};
}

export function startGateAllowsRun(observedCostUsd, maxCostUsd) {
	return observedCostUsd < maxCostUsd;
}

export function shouldAbortInflight(observedCostUsd, currentRunCostUsd, maxCostUsd) {
	// Best-effort only: provider reporting lags, so overshoot is possible.
	return observedCostUsd + currentRunCostUsd >= maxCostUsd;
}

function median(values) {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length === 0
		? 0
		: sorted.length % 2 === 1
			? sorted[middle]
			: (sorted[middle - 1] + sorted[middle]) / 2;
}

function conditionSummary(runs) {
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

export function summarizeRuns(runs) {
	const conditions = {};
	for (const condition of CONDITIONS) {
		const matching = runs.filter((run) => run.condition === condition);
		if (matching.length === 0) continue;
		const summary = conditionSummary(matching);
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
