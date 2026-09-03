// Case materialization, Pi argument assembly, and deterministic judging.

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractJudgeResult, extractMetricsFromSession } from "./metrics.mjs";
import { PiRpcClient } from "./rpc-client.mjs";

const PROJECT_PRESENTATION_DIRECTORY = [".pi"];
const PRESENTATION_FILE_NAME = "ptc.json";
const PTC_ENTRY_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));
const OBSERVER_PATH = fileURLToPath(new URL("./observer.ts", import.meta.url));

export async function loadCaseDefinition(name, casesDirectory) {
	const path = join(
		typeof casesDirectory === "string" ? casesDirectory : fileURLToPath(casesDirectory),
		`${name}.json`,
	);
	return { ...JSON.parse(await readFile(path, "utf8")), path };
}

export async function materializeCase(definition, directory, condition) {
	for (const file of definition.files) {
		const target = join(directory, file.path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, file.content, "utf8");
	}
	if (condition !== "absent") {
		const presentationFile = join(
			directory,
			...PROJECT_PRESENTATION_DIRECTORY,
			PRESENTATION_FILE_NAME,
		);
		await mkdir(dirname(presentationFile), { recursive: true });
		// Condition "native" keeps pi-ptc loaded with native presentation so the
		// extension cost itself is measured; "absent" does not load pi-ptc.
		await writeFile(
			presentationFile,
			JSON.stringify({ presentation: condition === "both" ? "both" : condition }, null, "\t"),
			"utf8",
		);
	}
}

export function judgeCaseResult(definition, finalText) {
	const judged = extractJudgeResult(finalText ?? "");
	if (!judged.ok) {
		return { correct: false, reason: judged.reason };
	}
	const expected = JSON.stringify(definition.expected);
	const actual = JSON.stringify(judged.value);
	if (expected !== actual) {
		return { correct: false, reason: `expected ${expected} but got ${actual}` };
	}
	return { correct: true, reason: "exact match" };
}

export function buildDecoyToolList(count) {
	const names = [];
	for (let index = 0; index < count; index += 1) names.push(`eval_decoy_${index}`);
	return names;
}

export async function executeRun({
	run,
	config,
	definition,
	workspaceDirectory,
	sessionDirectory,
	rpcLogPath,
	packageEntryPath,
	budgetCheck,
}) {
	await materializeCase(definition, workspaceDirectory, run.condition);
	const toolNames = [...definition.tools, ...buildDecoyToolList(config.catalogDecoyCount)];
	if (run.condition !== "absent") toolNames.push("ptc");
	const args = [
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--approve",
		"--session-dir",
		sessionDirectory,
		"--provider",
		run.model.provider,
		"--model",
		run.model.model,
		"--thinking",
		run.model.thinking,
		"--tools",
		toolNames.join(","),
		"--extension",
		OBSERVER_PATH,
	];
	if (run.condition !== "absent") {
		args.push("--extension", packageEntryPath ?? PTC_ENTRY_PATH);
	}
	const client = PiRpcClient.spawn(args, {
		cwd: workspaceDirectory,
		env: {
			...process.env,
			PI_PTC_EVAL_DECOYS: String(config.catalogDecoyCount),
		},
	});
	const startedAtMs = Date.now();
	let budgetAborted = false;
	const costPoller = setInterval(() => {
		if (typeof budgetCheck !== "function") return;
		const latest = [...client.events]
			.reverse()
			.find((event) => event?.type === "message_update" && event?.usage?.cost?.total !== undefined);
		const currentCost = latest?.usage?.cost?.total ?? 0;
		if (currentCost > 0 && budgetCheck(currentCost)) {
			budgetAborted = true;
			void client.abort();
		}
	}, 1000);
	costPoller.unref?.();
	try {
		await client.request({ type: "get_state" });
		await client.prompt(definition.prompt);
	} catch (error) {
		if (!budgetAborted) throw error;
	} finally {
		clearInterval(costPoller);
	}
	const [stats, entriesResponse, lastText] = await Promise.all([
		client.request({ type: "get_session_stats" }),
		client.request({ type: "get_entries" }),
		client.request({ type: "get_last_assistant_text" }),
	]);
	const wallTimeMs = Date.now() - startedAtMs;
	const metrics = extractMetricsFromSession({
		entries: entriesResponse.entries,
		stats,
	});
	const judged = judgeCaseResult(definition, lastText?.text);
	await writeFile(
		rpcLogPath,
		`${client.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
		"utf8",
	);
	if (typeof stats?.sessionFile === "string") {
		await copyFile(stats.sessionFile, join(dirname(rpcLogPath), "session.jsonl"));
	}
	await client.close();
	return {
		key: `${run.model.provider}/${run.model.model}/${run.case}/${run.condition}/${run.repetition}`,
		model: `${run.model.provider}/${run.model.model}`,
		case: run.case,
		condition: run.condition,
		repetition: run.repetition,
		...judged,
		...metrics,
		wallTimeMs,
		budgetAborted,
		sessionFile: stats?.sessionFile,
		stderr: client.stderr.join("").slice(0, 2000),
	};
}
