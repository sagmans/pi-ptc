import { strict as assert } from "node:assert";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { judgeCaseResult, loadCaseDefinition, materializeCase } from "../eval/case-definition.ts";
import {
	buildRunMatrix,
	extractMetricsFromSession,
	runKey,
	shouldAbortInflight,
	startGateAllowsRun,
	summarizeRuns,
	validateEvalConfig,
} from "../eval/metrics.ts";
import { buildDryRun, loadCompletedRuns, parseArguments, selectPendingRuns } from "../eval/run.ts";

const CONFIG_PATH = new URL("../eval/config.json", import.meta.url);
const PILOT_CONFIG_PATH = new URL("../eval/config.terminal-bench-pilot.json", import.meta.url);
const HEAVY_CONFIG_PATH = new URL("../eval/config.heavy-tools.json", import.meta.url);
const CODE_VS_ABSENT_CONFIG_PATH = new URL("../eval/config.code-vs-absent.json", import.meta.url);
const CASES_DIRECTORY = new URL("../eval/cases/", import.meta.url);

type TestConfig = {
	models: Array<{ provider: string; model: string; thinking: string }>;
	conditions: string[];
	repetitions: number;
	expectedRuns: number;
	maxCostUsd: number;
	forbiddenProviders: string[];
	catalogDecoyCount: number;
	cases: string[];
};

function loadConfig(path = CONFIG_PATH): TestConfig {
	return JSON.parse(readFileSync(path, "utf8")) as TestConfig;
}

test("evaluation configuration validates the exact approved matrix", () => {
	const config = validateEvalConfig(loadConfig());
	assert.deepEqual(config.errors, []);
	const runs = buildRunMatrix(config.value);
	assert.equal(runs.length, 32);
	assert.equal(
		new Set(
			runs.map(
				(run) =>
					`${run.model.provider}/${run.model.model}/${run.case}/${run.condition}/${run.repetition}`,
			),
		).size,
		32,
	);
});

test("Terminal-Bench pilot configuration isolates one case in a 16-run matrix", async () => {
	const config = validateEvalConfig(loadConfig(PILOT_CONFIG_PATH));
	assert.deepEqual(config.errors, []);
	assert.equal(buildRunMatrix(config.value).length, 16);
	assert.deepEqual(config.value.cases, ["large-scale-text-editing"]);
	const definition = await loadCaseDefinition("large-scale-text-editing", CASES_DIRECTORY);
	assert.equal(definition.judge, "large-scale-text-editing");
	if (definition.judge !== "large-scale-text-editing") assert.fail("unexpected case judge");
	assert.equal(definition.rowCount, 1_000_000);
	assert.equal(definition.settleTimeoutMs, 1_200_000);
});

test("configuration rejects duplicates, negative limits, and forbidden providers", () => {
	const base = loadConfig();
	const duplicated = validateEvalConfig({
		...base,
		models: [base.models[0], base.models[0]],
	});
	assert.equal(
		duplicated.errors.some((error) => /duplicate model/i.test(error)),
		true,
	);

	const negativeCost = validateEvalConfig({ ...base, maxCostUsd: -1 });
	assert.equal(
		negativeCost.errors.some((error) => /maxCostUsd/i.test(error)),
		true,
	);

	const forbidden = validateEvalConfig({
		...base,
		models: [{ provider: "anthropic", model: "claude-x", thinking: "medium" }],
	});
	assert.equal(
		forbidden.errors.some((error) => /forbidden provider/i.test(error)),
		true,
	);
});

test("repetition two reverses condition order to reduce ordering bias", () => {
	const runs = buildRunMatrix(validateEvalConfig(loadConfig()).value);
	const first = runs.filter((run) => run.repetition === 1).map((run) => run.condition);
	const second = runs.filter((run) => run.repetition === 2).map((run) => run.condition);
	assert.deepEqual(first.slice(0, 4), ["absent", "native", "both", "code"]);
	assert.deepEqual(second.slice(0, 4), ["code", "both", "native", "absent"]);
	assert.notDeepEqual(first.slice(0, 4), second.slice(0, 4));
});

test("cases materialize deterministic workspaces and judge exact results", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-ptc-eval-case-"));
	try {
		const definition = await loadCaseDefinition("dependent-reads", CASES_DIRECTORY);
		assert.ok("expected" in definition);
		await materializeCase(definition, directory, "code");
		const names = readdirSync(join(directory, "records")).sort();
		assert.equal(
			names.length,
			definition.files.filter((f) => f.path.startsWith("records/")).length,
		);
		assert.equal(existsSync(join(directory, ".pi", "ptc.json")), true);
		assert.equal(
			JSON.parse(readFileSync(join(directory, ".pi", "ptc.json"), "utf8")).presentation,
			"code",
		);

		const accepted = await judgeCaseResult(
			definition,
			`noise
EVAL_RESULT ${JSON.stringify(definition.expected)}
trailing prose`,
		);
		assert.equal(accepted.correct, true);

		const wrongSum = await judgeCaseResult(
			definition,
			`EVAL_RESULT ${JSON.stringify({ ...definition.expected, sum: 1 })}`,
		);
		assert.equal(wrongSum.correct, false);

		const malformed = await judgeCaseResult(definition, "no marker at all");
		assert.equal(malformed.correct, false);
		assert.match(malformed.reason, /EVAL_RESULT/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("paged-read exposes only read and requires pagination", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-ptc-eval-paged-"));
	try {
		const definition = await loadCaseDefinition("paged-read", CASES_DIRECTORY);
		await materializeCase(definition, directory, "native");
		assert.deepEqual(definition.tools, ["read"]);
		const payloadLine = definition.files[0].content
			.split("\n")
			.find((line) => line.startsWith("TARGET-PAYLOAD:"));
		assert.ok(payloadLine);
		assert.match(payloadLine, /TARGET-PAYLOAD:/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("metrics count nested dispatches separately from visible tool calls", () => {
	const metrics = extractMetricsFromSession({
		entries: [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "c1", name: "ptc", arguments: {} },
						{ type: "toolCall", id: "c2", name: "read", arguments: {} },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "ptc",
					isError: false,
					content: [{ type: "text", text: "x".repeat(10) }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "c2",
					toolName: "read",
					isError: true,
					content: [{ type: "text", text: "y".repeat(4) }],
				},
			},
			{ type: "custom", customType: "ptc-dispatch", data: {} },
			{ type: "custom", customType: "ptc-dispatch", data: {} },
			{ type: "custom", customType: "ptc-dispatch", data: {} },
			{ type: "custom", customType: "eval-provider-request-bytes", data: { bytes: 100 } },
			{ type: "custom", customType: "eval-provider-request-bytes", data: { bytes: 40 } },
		],
		stats: {
			tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 },
			cost: 0.5,
		},
	});
	assert.equal(metrics.assistantTurns, 1);
	assert.equal(metrics.visibleToolCalls, 2);
	assert.equal(metrics.ptcCalls, 1);
	assert.equal(metrics.nativeToolCalls, 1);
	assert.equal(metrics.nestedDispatches, 3);
	assert.deepEqual(metrics.providerRequestBytes, [100, 40]);
	assert.equal(
		metrics.visibleToolResultBytes,
		JSON.stringify([{ type: "text", text: "x".repeat(10) }]).length +
			JSON.stringify([{ type: "text", text: "y".repeat(4) }]).length,
	);
	assert.equal(metrics.toolErrors, 1);
	assert.equal(metrics.inputTokens, 10);
	assert.equal(metrics.costUsd, 0.5);
	assert.equal(metrics.strategy, "mixed");
});

test("budget gate never starts a run at or above the cap", () => {
	assert.equal(startGateAllowsRun(49.99, 50), true);
	assert.equal(startGateAllowsRun(50, 50), false);
	assert.equal(startGateAllowsRun(50.01, 50), false);
	assert.equal(shouldAbortInflight(30, 20.5, 50), true);
	assert.equal(shouldAbortInflight(30, 19.9, 50), false);
});

test("summary reports per-condition medians and deltas without significance claims", () => {
	const summary = summarizeRuns([
		{
			model: "m",
			case: "c",
			condition: "absent",
			repetition: 1,
			key: "absent-1",
			correct: true,
			reason: "exact match",
			assistantTurns: 4,
			providerRequestBytes: [100],
			visibleToolResultBytes: 50,
			costUsd: 1,
			wallTimeMs: 10,
			totalTokens: 100,
		},
		{
			model: "m",
			case: "c",
			condition: "absent",
			repetition: 2,
			key: "absent-2",
			correct: true,
			reason: "exact match",
			assistantTurns: 6,
			providerRequestBytes: [200],
			visibleToolResultBytes: 70,
			costUsd: 2,
			wallTimeMs: 30,
			totalTokens: 300,
		},
		{
			model: "m",
			case: "c",
			condition: "code",
			repetition: 1,
			key: "code-1",
			correct: true,
			reason: "exact match",
			assistantTurns: 2,
			providerRequestBytes: [150],
			visibleToolResultBytes: 30,
			costUsd: 1.5,
			wallTimeMs: 20,
			totalTokens: 200,
		},
		{
			model: "m",
			case: "c",
			condition: "code",
			repetition: 2,
			key: "code-2",
			correct: true,
			reason: "exact match",
			assistantTurns: 2,
			providerRequestBytes: [250],
			visibleToolResultBytes: 30,
			costUsd: 1.5,
			wallTimeMs: 20,
			totalTokens: 200,
		},
	]);
	assert.equal(summary.conditions.absent.medianAssistantTurns, 5);
	assert.equal(summary.conditions.code.medianAssistantTurns, 2);
	assert.equal(summary.conditions.code.deltaAssistantTurnsVsAbsent, -3);
	const codeRepetitions = summary.conditions.code?.repetitions as unknown[];
	assert.equal(codeRepetitions.length, 2);
});

test("heavy tool-use configuration validates a 16-run single-case matrix", () => {
	const config = validateEvalConfig(loadConfig(HEAVY_CONFIG_PATH));
	assert.deepEqual(config.errors, []);
	assert.deepEqual(config.value.cases, ["transitive-ledger"]);
	assert.equal(buildRunMatrix(config.value).length, 16);
});

test("code-vs-absent configuration validates a 72-run full matrix", () => {
	const config = validateEvalConfig(loadConfig(CODE_VS_ABSENT_CONFIG_PATH));
	assert.deepEqual(config.errors, []);
	assert.deepEqual(config.value.conditions, ["absent", "native", "both", "code"]);
	assert.equal(buildRunMatrix(config.value).length, 72);
	assert.equal(new Set(buildRunMatrix(config.value).map((run) => runKey(run))).size, 72);
});

test("configuration rejects unknown, empty, and duplicated conditions", () => {
	const base = loadConfig();
	assert.equal(validateEvalConfig({ ...base, conditions: ["absent", "nope"] }).ok, false);
	assert.equal(validateEvalConfig({ ...base, conditions: [] }).ok, false);
	assert.equal(validateEvalConfig({ ...base, conditions: ["code", "code"] }).ok, false);
});

test("transitive-ledger materializes 160 accounts and judges the exact closure", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-ptc-eval-ledger-"));
	try {
		const definition = await loadCaseDefinition("transitive-ledger", CASES_DIRECTORY);
		assert.ok("expected" in definition);
		const expected = definition.expected as { names: string[]; sum: number };
		await materializeCase(definition, directory, "code");
		assert.equal(readdirSync(join(directory, "ledger")).length, 160);
		assert.equal(expected.names.length, 65);
		const accepted = await judgeCaseResult(definition, `EVAL_RESULT ${JSON.stringify(expected)}`);
		assert.equal(accepted.correct, true);
		const wrongSum = await judgeCaseResult(
			definition,
			`EVAL_RESULT ${JSON.stringify({ ...expected, sum: 0 })}`,
		);
		assert.equal(wrongSum.correct, false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("proof cases materialize their files and judge exact results", async () => {
	const cases = [
		{ name: "scatter-gather", prefix: "pi-ptc-eval-scatter-", directory: "shards", files: 40 },
		{ name: "cursor-walk", prefix: "pi-ptc-eval-cursor-", directory: "pages", files: 61 },
		{ name: "noisy-ledger", prefix: "pi-ptc-eval-noisy-", directory: "ledger", files: 100 },
	];
	for (const proofCase of cases) {
		const directory = mkdtempSync(join(tmpdir(), proofCase.prefix));
		try {
			const definition = await loadCaseDefinition(proofCase.name, CASES_DIRECTORY);
			assert.ok("expected" in definition);
			const expected = definition.expected as Record<string, unknown>;
			await materializeCase(definition, directory, "code");
			assert.equal(readdirSync(join(directory, proofCase.directory)).length, proofCase.files);
			const accepted = await judgeCaseResult(definition, `EVAL_RESULT ${JSON.stringify(expected)}`);
			assert.equal(accepted.correct, true);
			const wrong = await judgeCaseResult(definition, "EVAL_RESULT {}");
			assert.equal(wrong.correct, false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
});

test("code-proof configuration validates a 120-run matrix", () => {
	const config = validateEvalConfig(
		JSON.parse(readFileSync(new URL("../eval/config.code-proof.json", import.meta.url), "utf8")),
	);
	assert.deepEqual(config.errors, []);
	if (config.ok) {
		assert.equal(buildRunMatrix(config.value).length, 120);
		assert.equal(new Set(buildRunMatrix(config.value).map((run) => runKey(run))).size, 120);
	}
});

test("argument parsing defaults to one job and validates the jobs flag", () => {
	assert.equal(parseArguments(["--config", "c", "--dry-run"]).jobs, 1);
	assert.equal(parseArguments(["--config", "c", "--run", "--jobs", "4"]).jobs, 4);
	for (const bad of ["0", "-2", "1.5", "many"]) {
		assert.throws(() => parseArguments(["--config", "c", "--run", "--jobs", bad]), /--jobs/);
	}
});

test("pending selection skips completed cells and error records resume", async () => {
	const matrix = buildRunMatrix(validateEvalConfig(loadConfig()).value);
	const pending = selectPendingRuns(matrix, new Set([runKey(matrix[0])]));
	assert.equal(pending.length, matrix.length - 1);
	assert.equal(
		pending.some((run) => runKey(run) === runKey(matrix[0])),
		false,
	);

	const directory = mkdtempSync(join(tmpdir(), "pi-ptc-eval-resume-"));
	try {
		mkdirSync(join(directory, "runs"));
		writeFileSync(
			join(directory, "runs", "done.json"),
			JSON.stringify({ key: "done", correct: true }),
		);
		writeFileSync(
			join(directory, "runs", "crashed.error.json"),
			JSON.stringify({ key: "crashed" }),
		);
		writeFileSync(join(directory, "runs", "trace.rpc.jsonl"), "{}\n");
		const loaded = await loadCompletedRuns(directory);
		assert.deepEqual([...loaded.keys()], ["done"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("dry run emits 32 unique descriptors with zero cost and no provider calls", async () => {
	const dry = await buildDryRun(loadConfig(), CONFIG_PATH);
	assert.equal(dry.runs.length, 32);
	assert.equal(new Set(dry.runs.map((run) => run.key)).size, 32);
	assert.equal(dry.providerCalls, 0);
	assert.equal(dry.costUsd, 0);
});
