// Evaluation entrypoint. --dry-run validates and prints the matrix;
// --run executes or resumes a run directory under .ptc-eval/.

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeRun, loadCaseDefinition } from "./case-runner.mjs";
import {
	buildRunMatrix,
	runKey,
	shouldAbortInflight,
	startGateAllowsRun,
	summarizeRuns,
	validateEvalConfig,
} from "./metrics.mjs";

const EVAL_OUTPUT_DIRECTORY = ".ptc-eval";
const RUNS_DIRECTORY = "runs";
const SUMMARY_JSON = "summary.json";
const SUMMARY_MD = "summary.md";

export function parseArguments(argv) {
	const options = { config: undefined, dryRun: false, run: false, resumeDirectory: undefined };
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag === "--config") options.config = value;
		else if (flag === "--dry-run" && value === undefined) {
			options.dryRun = true;
			index -= 1;
		} else if (flag === "--run" && value === undefined) {
			options.run = true;
			index -= 1;
		} else if (flag === "--resume") options.resumeDirectory = value;
		else throw new Error(`unknown or incomplete argument: ${flag}`);
	}
	if (!options.config) throw new Error("--config is required");
	if (options.dryRun === options.run) {
		throw new Error("choose exactly one of --dry-run or --run");
	}
	return options;
}

export async function buildDryRun(configValue, configPath) {
	const config = validateEvalConfig(configValue);
	if (!config.ok) throw new Error(`invalid evaluation config: ${config.errors.join("; ")}`);
	const runs = buildRunMatrix(config.value).map((run) => ({ ...run, key: runKey(run) }));
	return { configPath: String(configPath), runs, providerCalls: 0, costUsd: 0 };
}

async function loadCompletedRuns(runDirectory) {
	const completed = new Map();
	const directory = join(runDirectory, RUNS_DIRECTORY);
	try {
		for (const name of await readdir(directory)) {
			if (!name.endsWith(".json") || name.startsWith(".")) continue;
			const record = JSON.parse(await readFile(join(directory, name), "utf8"));
			if (record?.key) completed.set(record.key, record);
		}
	} catch {
		// A fresh run directory has no completed runs yet.
	}
	return completed;
}

async function writeAtomic(path, contents) {
	const temporary = `${path}.tmp`;
	await writeFile(temporary, contents, "utf8");
	await rename(temporary, path);
}

function renderSummaryMarkdown(summary) {
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

async function executeMatrix(options) {
	const configValue = JSON.parse(await readFile(options.config, "utf8"));
	const config = validateEvalConfig(configValue);
	if (!config.ok) throw new Error(`invalid evaluation config: ${config.errors.join("; ")}`);
	const runDirectory =
		options.resumeDirectory ??
		join(EVAL_OUTPUT_DIRECTORY, `run-${new Date().toISOString().replace(/[:.]/g, "-")}`);
	await mkdir(join(runDirectory, RUNS_DIRECTORY), { recursive: true });
	const definitions = new Map();
	for (const caseName of config.value.cases) {
		definitions.set(
			caseName,
			await loadCaseDefinition(caseName, join(options.config, "..", "cases")),
		);
	}
	const completed = await loadCompletedRuns(runDirectory);
	const matrix = buildRunMatrix(config.value);
	const results = [...completed.values()];
	let observedCost = results.reduce((total, record) => total + (record.costUsd ?? 0), 0);
	for (const run of matrix) {
		const key = runKey(run);
		if (completed.has(key)) continue;
		if (!startGateAllowsRun(observedCost, config.value.maxCostUsd)) {
			console.log(`budget reached (${observedCost.toFixed(2)} USD); stopping before ${key}`);
			break;
		}
		const workspaceDirectory = join(runDirectory, "workspace", key.replaceAll("/", "_"));
		await mkdir(workspaceDirectory, { recursive: true });
		const sessionDirectory = join(workspaceDirectory, "sessions");
		console.log(`running ${key}`);
		let budgetAbortRequested = false;
		const record = await executeRun({
			run,
			config: config.value,
			definition: definitions.get(run.case),
			workspaceDirectory,
			sessionDirectory,
			rpcLogPath: join(runDirectory, RUNS_DIRECTORY, `${key.replaceAll("/", "_")}.rpc.jsonl`),
			budgetCheck: (currentCostUsd) => {
				if (budgetAbortRequested) return false;
				const abort = shouldAbortInflight(observedCost, currentCostUsd, config.value.maxCostUsd);
				if (abort) budgetAbortRequested = true;
				return abort;
			},
		});
		await writeAtomic(
			join(runDirectory, RUNS_DIRECTORY, `${key.replaceAll("/", "_")}.json`),
			JSON.stringify(record, null, "\t"),
		);
		results.push(record);
		observedCost += record.costUsd ?? 0;
	}
	const summary = summarizeRuns(results);
	await writeAtomic(join(runDirectory, SUMMARY_JSON), JSON.stringify(summary, null, "\t"));
	await writeAtomic(join(runDirectory, SUMMARY_MD), renderSummaryMarkdown(summary));
	console.log(`run directory: ${runDirectory}`);
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	if (options.dryRun) {
		const configValue = JSON.parse(await readFile(options.config, "utf8"));
		const dry = await buildDryRun(configValue, options.config);
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
