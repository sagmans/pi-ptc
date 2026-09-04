// Evaluation entrypoint. --dry-run validates and prints the matrix;
// --run executes or resumes a run directory under .ptc-eval/.
// --jobs N runs up to N cells concurrently; each cell keeps an isolated
// workspace, session directory, RPC log, and atomically written result file.

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCaseDefinition } from "./case-definition.ts";
import {
	buildRunMatrix,
	type EvalRun,
	type EvaluatedRun,
	type RunSummary,
	runKey,
	shouldAbortInflight,
	startGateAllowsRun,
	summarizeRuns,
	validateEvalConfig,
} from "./metrics.ts";
import { executeRun } from "./session-runner.ts";

const EVAL_OUTPUT_DIRECTORY = ".ptc-eval";
const RUNS_DIRECTORY = "runs";
const SUMMARY_JSON = "summary.json";
const SUMMARY_MD = "summary.md";
const CASE_FLAG = "--case";

type RunOptions = {
	config: string;
	dryRun: boolean;
	run: boolean;
	resumeDirectory?: string;
	caseName?: string;
	jobs: number;
};

const ERROR_RECORD_SUFFIX = ".error.json";

export type DryRun = {
	configPath: string;
	runs: Array<EvalRun & { key: string }>;
	providerCalls: number;
	costUsd: number;
};

export function parseArguments(argv: string[]): RunOptions {
	const options: {
		config?: string;
		dryRun: boolean;
		run: boolean;
		resumeDirectory?: string;
		caseName?: string;
		jobs?: number;
	} = {
		config: undefined,
		dryRun: false,
		run: false,
		resumeDirectory: undefined,
		jobs: undefined,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === "--dry-run") options.dryRun = true;
		else if (flag === "--run") options.run = true;
		else if (
			flag === "--config" ||
			flag === "--resume" ||
			flag === "--jobs" ||
			flag === CASE_FLAG
		) {
			const value = argv[index + 1];
			if (
				typeof value !== "string" ||
				value.startsWith("--") ||
				(flag === CASE_FLAG && value.trim().length === 0)
			) {
				throw new Error(`${flag} requires a value`);
			}
			if (flag === "--config") options.config = value;
			else if (flag === "--resume") options.resumeDirectory = value;
			else if (flag === CASE_FLAG) {
				if (options.caseName !== undefined)
					throw new Error(`${CASE_FLAG} can be specified only once`);
				options.caseName = value;
			} else options.jobs = Number(value);
			index += 1;
		} else throw new Error(`unknown argument: ${flag}`);
	}
	if (!options.config) throw new Error("--config is required");
	if (options.dryRun === options.run) {
		throw new Error("choose exactly one of --dry-run or --run");
	}
	const jobs = options.jobs ?? 1;
	if (!Number.isSafeInteger(jobs) || jobs < 1) {
		throw new Error("--jobs must be a positive integer");
	}
	return {
		config: options.config,
		dryRun: options.dryRun,
		run: options.run,
		resumeDirectory: options.resumeDirectory,
		caseName: options.caseName,
		jobs,
	};
}

export async function buildDryRun(
	configValue: unknown,
	configPath: string | URL,
	caseName?: string,
): Promise<DryRun> {
	const config = validateEvalConfig(configValue);
	if (!config.ok) throw new Error(`invalid evaluation config: ${config.errors.join("; ")}`);
	const runs = buildRunMatrix(config.value, caseName).map((run) => ({ ...run, key: runKey(run) }));
	return { configPath: String(configPath), runs, providerCalls: 0, costUsd: 0 };
}

export function selectPendingRuns(
	matrix: readonly EvalRun[],
	completed: ReadonlyMap<string, unknown> | ReadonlySet<string>,
): EvalRun[] {
	return matrix.filter((run) => !completed.has(runKey(run)));
}

export async function loadCompletedRuns(runDirectory: string): Promise<Map<string, EvaluatedRun>> {
	const completed = new Map<string, EvaluatedRun>();
	const directory = join(runDirectory, RUNS_DIRECTORY);
	try {
		for (const name of await readdir(directory)) {
			// Error records mark crashed cells for resume; they are not results.
			if (name.endsWith(ERROR_RECORD_SUFFIX)) continue;
			if (!name.endsWith(".json") || name.startsWith(".")) continue;
			const record = JSON.parse(await readFile(join(directory, name), "utf8")) as EvaluatedRun;
			if (record?.key) completed.set(record.key, record);
		}
	} catch {
		// A fresh run directory has no completed runs yet.
	}
	return completed;
}

async function writeAtomic(path: string, contents: string): Promise<void> {
	const temporary = `${path}.tmp`;
	await writeFile(temporary, contents, "utf8");
	await rename(temporary, path);
}

function renderSummaryMarkdown(summary: RunSummary): string {
	const lines = [
		"# PTC evaluation summary",
		"",
		`Completed runs: ${summary.completed}`,
		`Observed cost: ${summary.totalCostUsd.toFixed(2)} USD`,
		`Note: ${summary.note}`,
		"",
		"| Condition | Runs | Correct | Median turns | Median request bytes | Median result bytes | Median tokens | Median cost |",
		"|---|---|---|---|---|---|---|---|",
	];
	for (const [condition, value] of Object.entries(summary.conditions)) {
		lines.push(
			`| ${condition} | ${value.count} | ${value.correct} | ${value.medianAssistantTurns} | ${value.medianProviderRequestBytes} | ${value.medianVisibleToolResultBytes} | ${value.medianTotalTokens} | ${value.medianCostUsd.toFixed(3)} |`,
		);
	}
	lines.push("", "## Failures", "");
	if (summary.failures.length === 0) lines.push("None.");
	for (const failure of summary.failures) lines.push(`- ${failure.key}: ${failure.reason}`);
	return `${lines.join("\n")}\n`;
}

async function executeMatrix(options: RunOptions): Promise<void> {
	const configValue = JSON.parse(await readFile(options.config, "utf8"));
	const config = validateEvalConfig(configValue);
	if (!config.ok) throw new Error(`invalid evaluation config: ${config.errors.join("; ")}`);
	const matrix = buildRunMatrix(config.value, options.caseName);
	const runDirectory =
		options.resumeDirectory ??
		join(EVAL_OUTPUT_DIRECTORY, `run-${new Date().toISOString().replace(/[:.]/g, "-")}`);
	await mkdir(join(runDirectory, RUNS_DIRECTORY), { recursive: true });
	const definitions = new Map();
	for (const caseName of new Set(matrix.map((run) => run.case))) {
		definitions.set(
			caseName,
			await loadCaseDefinition(caseName, join(options.config, "..", "cases")),
		);
	}
	const completed = await loadCompletedRuns(runDirectory);
	const pending = selectPendingRuns(matrix, completed);
	const results: EvaluatedRun[] = [...completed.values()];
	let observedCost = results.reduce((total, record) => total + (record.costUsd ?? 0), 0);
	let budgetStopped = false;
	// Cells mutate only their own workspace, session directory, RPC log, and
	// result file, so the pool shares nothing but the cost accumulator and the
	// results list. A crashed cell writes an error record and never kills siblings.
	const runCell = async (run: EvalRun): Promise<void> => {
		const key = runKey(run);
		const fileBase = key.replaceAll("/", "_");
		const workspaceDirectory = join(runDirectory, "workspace", fileBase);
		await mkdir(workspaceDirectory, { recursive: true });
		const sessionDirectory = join(workspaceDirectory, "sessions");
		console.log(`running ${key}`);
		let budgetAbortRequested = false;
		try {
			const record = await executeRun({
				run,
				definition: definitions.get(run.case),
				workspaceDirectory,
				sessionDirectory,
				rpcLogPath: join(runDirectory, RUNS_DIRECTORY, `${fileBase}.rpc.jsonl`),
				budgetCheck: (currentCostUsd: number) => {
					if (budgetAbortRequested) return false;
					const abort = shouldAbortInflight(observedCost, currentCostUsd, config.value.maxCostUsd);
					if (abort) budgetAbortRequested = true;
					return abort;
				},
			});
			await writeAtomic(
				join(runDirectory, RUNS_DIRECTORY, `${fileBase}.json`),
				JSON.stringify(record, null, "\t"),
			);
			results.push(record);
			observedCost += record.costUsd ?? 0;
			console.log(
				`finished ${key} (correct: ${record.correct}, cost: ${(record.costUsd ?? 0).toFixed(4)} USD)`,
			);
		} catch (error) {
			await writeAtomic(
				join(runDirectory, RUNS_DIRECTORY, `${fileBase}${ERROR_RECORD_SUFFIX}`),
				JSON.stringify({ key, error: String(error) }, null, "\t"),
			);
			console.error(`failed ${key}: ${error}`);
		}
	};
	const claimed = new Set<string>();
	const workers: Array<Promise<void>> = [];
	for (let worker = 0; worker < Math.min(options.jobs, pending.length); worker += 1) {
		workers.push(
			(async () => {
				for (const run of pending) {
					if (budgetStopped) return;
					// The start gate is best-effort under concurrency: cells already
					// running can push observed spend past the cap before the next
					// dispatch notices, exactly like provider cost-reporting lag.
					if (!startGateAllowsRun(observedCost, config.value.maxCostUsd)) {
						budgetStopped = true;
						console.log(
							`budget reached (${observedCost.toFixed(2)} USD); stopping before ${runKey(run)}`,
						);
						return;
					}
					if (claimed.has(runKey(run))) continue;
					claimed.add(runKey(run));
					await runCell(run);
				}
			})(),
		);
	}
	await Promise.all(workers);
	const summary = summarizeRuns(results);
	await writeAtomic(join(runDirectory, SUMMARY_JSON), JSON.stringify(summary, null, "\t"));
	await writeAtomic(join(runDirectory, SUMMARY_MD), renderSummaryMarkdown(summary));
	console.log(`run directory: ${runDirectory}`);
}

async function main(): Promise<void> {
	const options = parseArguments(process.argv.slice(2));
	if (options.dryRun) {
		const configValue = JSON.parse(await readFile(options.config, "utf8"));
		const dry = await buildDryRun(configValue, options.config, options.caseName);
		console.log(
			JSON.stringify(
				{ runs: dry.runs.length, providerCalls: dry.providerCalls, costUsd: dry.costUsd },
				null,
				"\t",
			),
		);
		return;
	}
	await executeMatrix(options);
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) await main();
