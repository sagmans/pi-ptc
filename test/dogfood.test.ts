import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCoreBindings, createOfficialExecutor } from "../src/bridge.ts";
import { SHIPPED_PTC_CONFIG } from "../src/config.ts";
import { createScheduler } from "../src/scheduler.ts";
import { createPtcTool, type PtcPartialResult } from "../src/transport.ts";

const FIRST_FILE_NAME = "alpha";
const SECOND_FILE_NAME = "beta";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-ptc-dogfood-"));
}

function toolFor() {
	return createPtcTool({
		timeoutMs: SHIPPED_PTC_CONFIG.timeoutMs,
		maxDispatches: SHIPPED_PTC_CONFIG.maxDispatches,
		maxOutputBytes: SHIPPED_PTC_CONFIG.maxOutputBytes,
		maxOutputLines: SHIPPED_PTC_CONFIG.maxOutputLines,
		createBindings: (ctx) =>
			createCoreBindings({
				execute: createOfficialExecutor(ctx.cwd),
				scheduler: createScheduler(SHIPPED_PTC_CONFIG.maxParallelDispatches),
				reportDispatch: ctx.reportDispatch,
			}),
	});
}

test("one program can read two files and return both names", async () => {
	const cwd = tempDir();
	writeFileSync(join(cwd, "package.json"), '{"name":"alpha"}\n');
	writeFileSync(join(cwd, "tsconfig.json"), '{"name":"beta"}\n');
	const updates: PtcPartialResult[] = [];
	const result = await toolFor().execute(
		"dogfood-read",
		{
			code: `
const [pkg, ts] = await Promise.all([
  tools.read({ path: "package.json" }),
  tools.read({ path: "tsconfig.json" }),
]);
return { pkg: JSON.parse(pkg.text).name, ts: JSON.parse(ts.text).name };
`,
			description: "Read both names",
		},
		undefined,
		(partial) => {
			updates.push(partial);
		},
		{ cwd },
	);
	assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), {
		logs: [],
		result: { pkg: FIRST_FILE_NAME, ts: SECOND_FILE_NAME },
	});
	assert.ok(updates.some((update) => update.content[0]?.text.includes("read … package.json")));
	assert.ok(updates.some((update) => update.content[0]?.text.includes("read … tsconfig.json")));
	assert.equal(result.details.dispatches.filter((entry) => entry.status === "ok").length, 2);
	assert.equal(
		updates.some((update) =>
			update.content.some((content) => content.text.includes(FIRST_FILE_NAME)),
		),
		false,
	);
});

test("a failing bash dispatch is catchable as ToolCallError", async () => {
	const cwd = tempDir();
	const result = await toolFor().execute(
		"dogfood-bash",
		{
			code: `
try {
  await tools.bash({ command: "exit 7" });
  return { caught: false };
} catch (error) {
  return {
    caught: error instanceof ToolCallError,
    toolName: error.toolName,
  };
}
`,
			description: "Catch failed bash",
		},
		undefined,
		undefined,
		{ cwd },
	);
	assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), {
		logs: [],
		result: { caught: true, toolName: "bash" },
	});
});
