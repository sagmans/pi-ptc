import { strict as assert } from "node:assert";
import test from "node:test";

import { createPtcTool } from "../src/transport.ts";
import {
	CUSTOM_DRAIN_TIMEOUT_MS,
	CUSTOM_MAX_DISPATCHES,
	CUSTOM_MAX_OUTPUT_BYTES,
	CUSTOM_MAX_OUTPUT_LINES,
	CUSTOM_MAX_PERSISTED_DETAILS_BYTES,
	LIMITS,
	OVERSIZED_FAILURE_MESSAGE,
} from "./support/transport-harness.ts";

const TRANSPORT_OUTPUT_LIMIT_MESSAGE =
	"ptc failed (output-limit): worker error message exceeds maxOutputBytes: 7000 > 1234";

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
		timeoutMs: LIMITS.timeoutMs,
		maxDispatches: LIMITS.maxDispatches,
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

test("ptc bounds worker failure messages before Pi persists them", async () => {
	const tool = createPtcTool({
		...LIMITS,
		maxOutputBytes: CUSTOM_MAX_OUTPUT_BYTES,
		maxOutputLines: CUSTOM_MAX_OUTPUT_LINES,
		createBindings: () => ({}),
	});
	let rejection: Error | undefined;

	try {
		await tool.execute(
			"call-large-failure",
			{
				code: `throw new Error(${JSON.stringify(OVERSIZED_FAILURE_MESSAGE)});`,
				description: "bound a worker failure",
			},
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);
	} catch (error) {
		rejection = error as Error;
	}

	assert.equal(rejection?.message, TRANSPORT_OUTPUT_LIMIT_MESSAGE);
	assert.ok(Buffer.byteLength(rejection?.message ?? "", "utf8") <= CUSTOM_MAX_OUTPUT_BYTES);
});

test("ptc forwards output and dispatch limits into the runtime seam", async () => {
	let captured:
		| {
				drainTimeoutMs?: number;
				maxBindingCalls?: number;
				maxOutputBytes?: number;
				maxOutputLines?: number;
		  }
		| undefined;
	const tool = createPtcTool({
		timeoutMs: LIMITS.timeoutMs,
		drainTimeoutMs: CUSTOM_DRAIN_TIMEOUT_MS,
		maxDispatches: CUSTOM_MAX_DISPATCHES,
		maxOutputBytes: CUSTOM_MAX_OUTPUT_BYTES,
		maxOutputLines: CUSTOM_MAX_OUTPUT_LINES,
		maxPersistedDetailsBytes: CUSTOM_MAX_PERSISTED_DETAILS_BYTES,
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

	assert.equal(captured?.drainTimeoutMs, CUSTOM_DRAIN_TIMEOUT_MS);
	assert.equal(captured?.maxBindingCalls, CUSTOM_MAX_DISPATCHES);
	assert.equal(captured?.maxOutputBytes, CUSTOM_MAX_OUTPUT_BYTES);
	assert.equal(captured?.maxOutputLines, CUSTOM_MAX_OUTPUT_LINES);
});
