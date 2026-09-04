import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type EvalConfig, runKey } from "../eval/metrics.ts";
import { buildDryRun, parseArguments, selectPendingRuns } from "../eval/run.ts";

const CONFIG_PATH = fileURLToPath(new URL("../eval/config.counter-proof.json", import.meta.url));
const RUNNER_PATH = fileURLToPath(new URL("../eval/run.ts", import.meta.url));
const CASE_NAME = "semantic-trail";
const OTHER_CASE_NAME = "unavailable-case";
const CASE_FLAG = "--case";
const SINGLE_CASE_RUNS = 52;
const TWO_CASE_RUNS = 104;
const CLI_TIMEOUT_MS = 10_000;
const TEMP_PREFIX = "pi-ptc-eval-case-cli-";
const RESUME_DIRECTORY = "resume";
const RUNS_DIRECTORY = "runs";
const SUMMARY_FILE = "summary.json";
const OUTPUT_DIRECTORY = ".ptc-eval";
const CONFIG_FILE = "config.json";
const CASES_DIRECTORY = "cases";
const COMPLETED_FILE = "completed.json";
const CLI_ENV = { PATH: "" };
const MODES = ["--dry-run", "--run"];
const INVALID_CASES = ["", OTHER_CASE_NAME, `${CASE_NAME}.json`, `../${CASE_NAME}`];
const CASE_FIXTURE = {
	name: CASE_NAME,
	description: "The budget gate prevents provider execution.",
	tools: [],
	prompt: "No agent should receive this prompt.",
	files: [],
	expected: {},
};
const runCli = promisify(execFile);

function loadConfig(): EvalConfig {
	return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as EvalConfig;
}

test("case arguments accept one exact name and reject missing or repeated selections", () => {
	for (const mode of MODES) {
		const args = ["--config", CONFIG_PATH, mode];
		assert.equal(parseArguments(args).caseName, undefined);
		const selected = parseArguments([
			...args,
			CASE_FLAG,
			CASE_NAME,
			"--jobs",
			String(SINGLE_CASE_RUNS),
			"--resume",
			RESUME_DIRECTORY,
		]);
		assert.equal(selected.caseName, CASE_NAME);
		assert.equal(selected.jobs, SINGLE_CASE_RUNS);
		assert.equal(selected.resumeDirectory, RESUME_DIRECTORY);
		for (const values of [[], [""], [" "], ["--jobs", "1"]]) {
			assert.throws(
				() => parseArguments([...args, CASE_FLAG, ...values]),
				/--case requires a value/,
			);
		}
		assert.throws(
			() => parseArguments([...args, CASE_FLAG, CASE_NAME, CASE_FLAG, OTHER_CASE_NAME]),
			/--case.*once/,
		);
	}
});

test("case selection preserves all model pairs, run keys, ordering, and the source config", async () => {
	const config = loadConfig();
	const original = structuredClone(config);
	const full = await buildDryRun(config, CONFIG_PATH);
	const selected = await buildDryRun(config, CONFIG_PATH, CASE_NAME);
	assert.equal(full.runs.length, config.expectedRuns);
	assert.equal(selected.runs.length, SINGLE_CASE_RUNS);
	assert.equal(new Set(selected.runs.map((run) => run.key)).size, SINGLE_CASE_RUNS);
	assert.deepEqual(
		selected.runs,
		full.runs.filter((run) => run.case === CASE_NAME),
	);
	assert.deepEqual(config, original);
	assert.equal(selected.providerCalls, 0);
	assert.equal(selected.costUsd, 0);
	const completed = new Set([selected.runs[0].key]);
	const pending = selectPendingRuns(selected.runs, completed);
	assert.equal(pending.length, SINGLE_CASE_RUNS - completed.size);
	assert.ok(pending.every((run) => run.case === CASE_NAME && !completed.has(runKey(run))));
});

test("case selection rejects unknown names and still validates the original full matrix", async () => {
	for (const name of INVALID_CASES) {
		await assert.rejects(buildDryRun(loadConfig(), CONFIG_PATH, name), /case.*configured/);
	}
	const invalid = { ...loadConfig(), expectedRuns: SINGLE_CASE_RUNS };
	await assert.rejects(buildDryRun(invalid, CONFIG_PATH, CASE_NAME), /invalid evaluation config/);
});

test("the CLI reports selected dry-run counts and rejects invalid live selections before writing", async () => {
	const directory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
	try {
		const options = { cwd: directory, env: CLI_ENV, timeout: CLI_TIMEOUT_MS };
		const dry = await runCli(
			process.execPath,
			[RUNNER_PATH, "--config", CONFIG_PATH, "--dry-run", CASE_FLAG, CASE_NAME],
			options,
		);
		assert.deepEqual(JSON.parse(dry.stdout), {
			runs: SINGLE_CASE_RUNS,
			providerCalls: 0,
			costUsd: 0,
		});
		assert.equal(existsSync(join(directory, OUTPUT_DIRECTORY)), false);
		await assert.rejects(
			runCli(
				process.execPath,
				[RUNNER_PATH, "--config", CONFIG_PATH, "--run", CASE_FLAG, OTHER_CASE_NAME],
				options,
			),
			/case.*configured/,
		);
		assert.equal(existsSync(join(directory, OUTPUT_DIRECTORY)), false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("case-filtered execution loads only selected definitions and retains resume-wide spend", async () => {
	const directory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
	try {
		const configPath = join(directory, CONFIG_FILE);
		const resumePath = join(directory, RESUME_DIRECTORY);
		const config = {
			...loadConfig(),
			cases: [CASE_NAME, OTHER_CASE_NAME],
			expectedRuns: TWO_CASE_RUNS,
		};
		writeFileSync(configPath, JSON.stringify(config));
		mkdirSync(join(directory, CASES_DIRECTORY));
		writeFileSync(
			join(directory, CASES_DIRECTORY, `${CASE_NAME}.json`),
			JSON.stringify(CASE_FIXTURE),
		);
		mkdirSync(join(resumePath, RUNS_DIRECTORY), { recursive: true });
		writeFileSync(
			join(resumePath, RUNS_DIRECTORY, COMPLETED_FILE),
			JSON.stringify({
				key: OTHER_CASE_NAME,
				case: OTHER_CASE_NAME,
				condition: "absent",
				repetition: 1,
				correct: true,
				reason: "exact match",
				assistantTurns: 0,
				providerRequestBytes: [],
				visibleToolResultBytes: 0,
				totalTokens: 0,
				costUsd: config.maxCostUsd,
				wallTimeMs: 0,
			}),
		);
		const result = await runCli(
			process.execPath,
			[RUNNER_PATH, "--config", configPath, "--run", CASE_FLAG, CASE_NAME, "--resume", resumePath],
			{ cwd: directory, env: CLI_ENV, timeout: CLI_TIMEOUT_MS },
		);
		assert.match(result.stdout, /budget reached/);
		assert.doesNotMatch(result.stdout, /^running /m);
		const summary = JSON.parse(readFileSync(join(resumePath, SUMMARY_FILE), "utf8"));
		assert.equal(summary.completed, 1);
		assert.equal(summary.totalCostUsd, config.maxCostUsd);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
