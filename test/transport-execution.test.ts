import { strict as assert } from "node:assert";
import test from "node:test";

import type { CodeRunFailure } from "../src/runtime-contract.ts";
import {
	assertOuterResultWithinLimits,
	createPtcTool,
	serializeOuterResult,
} from "../src/transport.ts";
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
	"ptc failed [PTC_OUTPUT_LIMIT]\n" +
	"Cause: worker error message exceeds maxOutputBytes: 7000 > 1234\n" +
	"Resolution: Return a smaller projection and keep console output concise.\n" +
	"Retry safety: verify state before retrying; nested tools may have executed";
const COMBINED_OUTER_BYTES = 27;
const COMBINED_OUTER_MAX_BYTES = COMBINED_OUTER_BYTES - 1;
const OUTER_LINE_COUNT = 2;
const OUTER_MAX_LINES = OUTER_LINE_COUNT - 1;

test("every runtime failure gives the agent a unique code and correction guidance", () => {
	const cases: Array<{ error: CodeRunFailure; code: string }> = [
		{ error: { kind: "program-transform", message: "bad syntax" }, code: "PTC_PROGRAM_TRANSFORM" },
		{ error: { kind: "program-compile", message: "bad syntax" }, code: "PTC_PROGRAM_COMPILE" },
		{ error: { kind: "program-runtime", message: "boom" }, code: "PTC_PROGRAM_RUNTIME" },
		{
			error: { kind: "binding-arguments-json", toolName: "read", message: "undefined" },
			code: "PTC_BINDING_ARGUMENT_JSON",
		},
		{
			error: { kind: "binding-arguments-limit", toolName: "read", message: "too large" },
			code: "PTC_BINDING_ARGUMENT_LIMIT",
		},
		{
			error: { kind: "tool-call", toolName: "read", message: "missing" },
			code: "PTC_TOOL_CALL",
		},
		{
			error: { kind: "program-result-json", message: "undefined" },
			code: "PTC_PROGRAM_RESULT_JSON",
		},
		{
			error: { kind: "result-delivery", toolName: "write", message: "lost" },
			code: "PTC_TOOL_RESULT_DELIVERY",
		},
		{ error: { kind: "worker-protocol", message: "invalid" }, code: "PTC_WORKER_PROTOCOL" },
		{ error: { kind: "output-limit", message: "too large" }, code: "PTC_OUTPUT_LIMIT" },
		{ error: { kind: "dispatch-limit" }, code: "PTC_DISPATCH_LIMIT" },
		{ error: { kind: "dangling-dispatch" }, code: "PTC_DANGLING_DISPATCH" },
		{ error: { kind: "orphan-limit" }, code: "PTC_ORPHAN_LIMIT" },
		{ error: { kind: "timeout" }, code: "PTC_TIMEOUT" },
		{ error: { kind: "abort" }, code: "PTC_ABORTED" },
		{ error: { kind: "worker-exit", message: "exit 1" }, code: "PTC_WORKER_EXIT" },
	];
	const codes = new Set<string>();
	for (const testCase of cases) {
		assert.throws(
			() => serializeOuterResult({ logs: [], error: testCase.error }, LIMITS),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.equal(error.message.startsWith(`ptc failed [${testCase.code}]\nCause: `), true);
				assert.match(error.message, /\nResolution: .+\nRetry safety: .+/);
				return true;
			},
		);
		assert.equal(codes.has(testCase.code), false);
		codes.add(testCase.code);
	}
});

test("binding argument failures do not claim earlier dispatches were absent", () => {
	assert.throws(
		() =>
			serializeOuterResult(
				{
					logs: [],
					error: {
						kind: "binding-arguments-json",
						toolName: "read",
						message: "undefined",
					},
				},
				LIMITS,
			),
		/Retry safety: verify state before retrying; nested tools may have executed/,
	);
});

test("failure tool names escape terminal, bidi, and line controls", () => {
	const toolName = "tool\u0085\u009b\u2028\u202eend";
	assert.throws(
		() =>
			serializeOuterResult(
				{
					logs: [],
					error: { kind: "tool-call", toolName, message: "failed" },
				},
				LIMITS,
			),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /for tool "tool\\u0085\\u009b\\u2028\\u202eend"/);
			assert.equal(error.message.includes(toolName), false);
			return true;
		},
	);
});

test("failure guidance overflow remains a classified output-limit failure", () => {
	const maxOutputBytes = 512;
	assert.throws(
		() =>
			serializeOuterResult(
				{
					logs: [],
					error: { kind: "program-runtime", message: "x".repeat(maxOutputBytes - 1) },
				},
				{ maxOutputBytes, maxOutputLines: CUSTOM_MAX_OUTPUT_LINES },
			),
		/PTC_OUTPUT_LIMIT/,
	);
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

test("combined outer overflow reports measured bytes", () => {
	assert.throws(
		() =>
			serializeOuterResult(
				{ logs: ["a"], result: "b" },
				{ maxOutputBytes: COMBINED_OUTER_MAX_BYTES, maxOutputLines: CUSTOM_MAX_OUTPUT_LINES },
			),
		{
			message: `outer result exceeds maxOutputBytes: ${COMBINED_OUTER_BYTES} > ${COMBINED_OUTER_MAX_BYTES}`,
		},
	);
});

test("outer line overflow reports measured lines", () => {
	assert.throws(
		() =>
			assertOuterResultWithinLimits("one\ntwo", {
				maxOutputBytes: CUSTOM_MAX_OUTPUT_BYTES,
				maxOutputLines: OUTER_MAX_LINES,
			}),
		{ message: `outer result exceeds maxOutputLines: ${OUTER_LINE_COUNT} > ${OUTER_MAX_LINES}` },
	);
});

test("serializeOuterResult rejects multiline results that JSON escaping hides", () => {
	assert.throws(
		() =>
			serializeOuterResult(
				{ logs: [], result: { body: "one\ntwo\nthree" } },
				{ maxOutputBytes: CUSTOM_MAX_OUTPUT_BYTES, maxOutputLines: 2 },
			),
		{ message: "outer result exceeds maxOutputLines: 3 > 2" },
	);
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
