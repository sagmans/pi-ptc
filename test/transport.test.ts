import { strict as assert } from "node:assert";
import test from "node:test";

import { createCoreBindings } from "../src/bridge.ts";
import { TRUST_COPY } from "../src/config.ts";
import { createScheduler } from "../src/scheduler.ts";
import { createPtcTool } from "../src/transport.ts";

const LIMITS = {
	timeoutMs: 2000,
	maxOutputBytes: 51200,
	maxOutputLines: 2000,
};

test("ptc description names bash-equivalent trust", () => {
	const tool = createPtcTool({
		...LIMITS,
		createBindings: () => ({}),
	});
	assert.match(tool.description, new RegExp(TRUST_COPY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.equal(tool.name, "ptc");
});

test("ptc returns logs and a curated result", async () => {
	const tool = createPtcTool({
		...LIMITS,
		createBindings: () => ({
			echo: async (args) => args,
		}),
	});
	const result = await tool.execute(
		"call-1",
		{ code: 'console.log("hi"); return await tools.echo({ n: 2 });', description: "echo" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	assert.equal(result.content[0]?.type, "text");
	assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), {
		logs: ["hi"],
		result: { n: 2 },
	});
});

test("ptc rejects an oversized outer result", async () => {
	const tool = createPtcTool({
		timeoutMs: 2000,
		maxOutputBytes: 16,
		maxOutputLines: 2000,
		createBindings: () => ({}),
	});
	await assert.rejects(
		() =>
			tool.execute(
				"call-2",
				{ code: 'return "0123456789abcdef";', description: "overflow" },
				undefined,
				undefined,
				{ cwd: process.cwd() },
			),
		/outer result exceeds/,
	);
});

test("ptc forwards output limits into the runtime seam", async () => {
	let captured: { maxOutputBytes?: number; maxOutputLines?: number } | undefined;
	const tool = createPtcTool({
		timeoutMs: 2000,
		maxOutputBytes: 1234,
		maxOutputLines: 56,
		createBindings: () => ({}),
		run: async (request) => {
			captured = request;
			return { logs: [], result: null };
		},
	});

	await tool.execute(
		"call-limits",
		{ code: "return null;", description: "check limits" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);

	assert.equal(captured?.maxOutputBytes, 1234);
	assert.equal(captured?.maxOutputLines, 56);
});

test("ptc aborts the worker when the call signal fires", async () => {
	const tool = createPtcTool({
		...LIMITS,
		createBindings: () => ({
			hang: () => new Promise(() => undefined),
		}),
	});
	const controller = new AbortController();
	const pending = tool.execute(
		"call-3",
		{ code: "await tools.hang(null); return 1;", description: "hang" },
		controller.signal,
		undefined,
		{ cwd: process.cwd() },
	);
	controller.abort();
	await assert.rejects(pending, /abort/);
});

async function waitForUpdates(updates: unknown[], count: number, timeoutMs = 1000): Promise<void> {
	const started = Date.now();
	while (updates.length < count) {
		if (Date.now() - started > timeoutMs) {
			throw new Error(`timed out waiting for ${count} updates, got ${updates.length}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("ptc streams dispatch start then ok through onUpdate", async () => {
	const updates: Array<{ content: Array<{ text: string }>; details: { dispatches: unknown[] } }> =
		[];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const secret = "SECRET_FILE_BYTES";
	const tool = createPtcTool({
		...LIMITS,
		createBindings: (ctx) =>
			createCoreBindings({
				execute: async () => {
					await gate;
					return { content: [{ type: "text", text: secret }] };
				},
				scheduler: createScheduler(2),
				reportDispatch: ctx.reportDispatch,
			}),
	});
	const pending = tool.execute(
		"call-4",
		{
			code: 'const r = await tools.read({ path: "note.txt" }); return r.text.length;',
			description: "read note",
		},
		undefined,
		(partial) => {
			updates.push(partial as (typeof updates)[number]);
		},
		{ cwd: process.cwd() },
	);
	await waitForUpdates(updates, 1);
	assert.equal(updates[0]?.content[0]?.text, "read … note.txt");
	assert.equal(JSON.stringify(updates).includes(secret), false);
	release();
	const result = await pending;
	assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), {
		logs: [],
		result: secret.length,
	});
	assert.deepEqual(result.details.dispatches, [
		{ id: 1, name: "read", args: { path: "note.txt" }, status: "ok" },
	]);
	assert.deepEqual(updates.at(-1)?.details.dispatches, [
		{ id: 1, name: "read", args: { path: "note.txt" }, status: "ok" },
	]);
	assert.equal(updates.at(-1)?.content[0]?.text, "read ok note.txt");
});
