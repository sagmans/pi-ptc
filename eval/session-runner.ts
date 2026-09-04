// Pi RPC session execution for one evaluation run.

import { copyFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CaseDefinition, judgeCaseResult, materializeCase } from "./case-definition.ts";
import {
	type EvalCondition,
	type EvalConfig,
	type EvalRun,
	extractMetricsFromSession,
	type SessionMetrics,
	type SessionStats,
} from "./metrics.ts";
import { PiRpcClient } from "./rpc-client.ts";
import type { LargeScaleTextEditingResult } from "./terminal-bench/large-scale-text-editing.ts";

const PTC_ENTRY_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));
const OBSERVER_PATH = fileURLToPath(new URL("./observer.ts", import.meta.url));

export type EvalRunResult = {
	key: string;
	model: string;
	case: string;
	condition: EvalCondition;
	repetition: number;
} & LargeScaleTextEditingResult &
	SessionMetrics & {
		wallTimeMs: number;
		budgetAborted: boolean;
		sessionFile?: string;
		stderr: string;
	};

export function buildDecoyToolList(count: number): string[] {
	const names: string[] = [];
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
}: {
	run: EvalRun;
	config: EvalConfig & Record<string, unknown>;
	definition: CaseDefinition;
	workspaceDirectory: string;
	sessionDirectory: string;
	rpcLogPath: string;
	packageEntryPath?: string;
	budgetCheck?: (currentCostUsd: number) => boolean;
}): Promise<EvalRunResult> {
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
		settleTimeoutMs: definition.settleTimeoutMs,
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
		client.request<SessionStats>({ type: "get_session_stats" }),
		client.request<{ entries: unknown[] }>({ type: "get_entries" }),
		client.request<{ text?: string }>({ type: "get_last_assistant_text" }),
	]);
	const wallTimeMs = Date.now() - startedAtMs;
	const metrics = extractMetricsFromSession({
		entries: entriesResponse.entries,
		stats,
	});
	const judged = await judgeCaseResult(definition, lastText?.text, workspaceDirectory);
	await writeFile(
		rpcLogPath,
		`${client.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
		"utf8",
	);
	const sessionFile = stats?.sessionFile;
	if (typeof sessionFile === "string") {
		// Pi reports the session path relative to its own cwd; resolve against
		// the per-run workspace and store the copy beside the RPC log.
		const sessionSource = isAbsolute(sessionFile)
			? sessionFile
			: join(workspaceDirectory, sessionFile);
		await copyFile(sessionSource, `${rpcLogPath.replace(/\.rpc\.jsonl$/, "")}.session.jsonl`);
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
		sessionFile,
		stderr: client.stderr.join("").slice(0, 2000),
	};
}
