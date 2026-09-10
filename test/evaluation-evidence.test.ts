import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CaseDefinition } from "../eval/case-definition.ts";
import { buildEvidenceIndex, type EvalRun } from "../eval/metrics.ts";
import { PiRpcClient } from "../eval/rpc-client.ts";
import { executeRun } from "../eval/session-runner.ts";

const TEMP_PREFIX = "pi-ptc-eval-evidence-";
const FINAL_TEXT = "An answer for a human and LLM to assess, not a machine verdict.";
const MODEL = { provider: "fixture", model: "local", thinking: "medium" };
const CASE_NAME = "manual-review";
const CASE_PATH = "case-definition.json";
const LOG_FILE = "run.rpc.jsonl";
const PROMPT = "Complete the task.";
const STATS = { tokens: { input: 12, output: 3, total: 15 }, cost: 0.25 };
const ENTRIES = [
	{
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: FINAL_TEXT }] },
	},
];
const DEFINITIONS: CaseDefinition[] = [
	{
		name: CASE_NAME,
		path: CASE_PATH,
		description: PROMPT,
		tools: [],
		prompt: PROMPT,
		files: [],
		expected: {},
	},
	{
		name: CASE_NAME,
		path: CASE_PATH,
		description: PROMPT,
		tools: [],
		prompt: PROMPT,
		files: [],
		judge: "large-scale-text-editing",
		rowCount: 1,
		provenance: {
			suite: "fixture",
			task: CASE_NAME,
			source: "local",
			digest: "fixture",
			license: "Apache-2.0",
		},
	},
];

test("session execution preserves answers and counters without judging either case type", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
	const responses: Record<string, unknown> = {
		get_state: {},
		get_session_stats: STATS,
		get_entries: { entries: ENTRIES },
		get_last_assistant_text: { text: FINAL_TEXT },
	};
	t.mock.method(PiRpcClient, "spawn", () => ({
		events: [],
		stderr: [],
		request: async ({ type }: { type: string }) => {
			assert.ok(Object.hasOwn(responses, type));
			return responses[type];
		},
		prompt: async () => {},
		close: async () => {},
	}));
	try {
		for (const definition of DEFINITIONS) {
			const run: EvalRun = { model: MODEL, case: CASE_NAME, condition: "absent", repetition: 1 };
			const record = await executeRun({
				run,
				definition,
				workspaceDirectory: directory,
				sessionDirectory: directory,
				rpcLogPath: join(directory, LOG_FILE),
			});
			assert.equal(record.finalText, FINAL_TEXT);
			assert.equal(record.caseDefinitionPath, CASE_PATH);
			assert.equal(Object.hasOwn(record, "correct"), false);
			assert.equal(Object.hasOwn(record, "reason"), false);
			assert.equal(record.totalTokens, STATS.tokens.total);
			assert.equal(record.costUsd, STATS.cost);
			assert.equal(record.assistantTurns, 1);
			assert.equal(record.budgetAborted, false);
			assert.ok(record.wallTimeMs >= 0);
			assert.equal(readFileSync(join(directory, LOG_FILE), "utf8").trim(), "");
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("evidence index retains legacy run keys and spend without comparative judgments", () => {
	const summary = buildEvidenceIndex([
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
	assert.equal(summary.completed, 4);
	assert.equal(summary.totalCostUsd, 6);
	assert.deepEqual(summary.runKeys, ["absent-1", "absent-2", "code-1", "code-2"]);
	assert.deepEqual(Object.keys(summary).sort(), ["completed", "note", "runKeys", "totalCostUsd"]);
	assert.match(summary.note, /manual/i);
});
