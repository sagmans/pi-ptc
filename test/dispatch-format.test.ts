import { strict as assert } from "node:assert";
import test from "node:test";

import { createCoreBindings, type DispatchProgress, formatDispatchLine } from "../src/bridge.ts";
import { ToolCallError } from "../src/canonical.ts";
import { createScheduler } from "../src/scheduler.ts";
import { BINDING_SIGNAL } from "./support/tool-bindings-harness.ts";

test("bridge reports one stable dispatch record with its native result", async () => {
	const order: string[] = [];
	const reported: DispatchProgress[] = [];
	const bindings = createCoreBindings({
		execute: async () => {
			order.push("execute");
			return { content: [{ type: "text", text: "hello" }] };
		},
		scheduler: createScheduler(2),
		reportDispatch: (progress) => {
			order.push(progress.status);
			reported.push(progress);
		},
	});
	await bindings.read({ path: "a.txt" }, BINDING_SIGNAL);
	assert.deepEqual(order, ["start", "execute", "ok"]);
	assert.deepEqual(reported, [
		{ id: 1, name: "read", args: { path: "a.txt" }, status: "start" },
		{
			id: 1,
			name: "read",
			args: { path: "a.txt" },
			status: "ok",
			result: {
				content: [{ type: "text", text: "hello" }],
				details: undefined,
				isError: false,
			},
		},
	]);
});

test("bridge keeps bounded tail and head previews for native-like rows", async () => {
	const lines = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join("\n");
	const reported: DispatchProgress[] = [];
	const bindings = createCoreBindings({
		execute: async () => ({ content: [{ type: "text", text: lines }] }),
		scheduler: createScheduler(2),
		reportDispatch: (progress) => {
			reported.push(progress);
		},
	});

	await bindings.bash({ command: "printf lines" }, BINDING_SIGNAL);
	await bindings.grep({ pattern: "line", path: "src" }, BINDING_SIGNAL);

	const settled = reported.filter((progress) => progress.status === "ok");
	assert.deepEqual(
		settled.map(({ result: _result, ...progress }) => progress),
		[
			{
				id: 1,
				name: "bash",
				args: { command: "printf lines" },
				status: "ok",
				preview: "…\nline-3\nline-4\nline-5\nline-6\nline-7\nline-8\nline-9\nline-10",
			},
			{
				id: 2,
				name: "grep",
				args: { pattern: "line", path: "src" },
				status: "ok",
				preview: "line-1\nline-2\nline-3\nline-4\nline-5\nline-6\nline-7\nline-8\n…",
			},
		],
	);
	assert.deepEqual(
		settled.map((progress) => progress.result?.content[0]?.text),
		[lines, lines],
	);
});

test("bridge reports err after factory failure", async () => {
	const statuses: string[] = [];
	const bindings = createCoreBindings({
		execute: async () => {
			throw new Error("missing");
		},
		scheduler: createScheduler(2),
		reportDispatch: (progress) => {
			statuses.push(progress.status);
		},
	});
	await assert.rejects(() => bindings.read({ path: "gone.txt" }, BINDING_SIGNAL), ToolCallError);
	assert.deepEqual(statuses, ["start", "err"]);
});

test("formatDispatchLine names the tool, status, and target", () => {
	assert.equal(
		formatDispatchLine({ name: "read", args: { path: "a.txt" }, status: "start" }),
		"read … a.txt",
	);
	assert.equal(
		formatDispatchLine({ name: "read", args: { path: "a.txt" }, status: "ok" }),
		"read ok a.txt",
	);
	assert.equal(
		formatDispatchLine({ name: "bash", args: { command: "true" }, status: "err" }),
		"bash err true",
	);
	assert.equal(formatDispatchLine({ name: "ls", args: {}, status: "start" }), "ls …");
});
