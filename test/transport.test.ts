import { strict as assert } from "node:assert";
import test from "node:test";

import { TRUST_COPY } from "../src/config.ts";
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
