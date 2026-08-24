import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCoreBindings, createOfficialExecutor, formatDispatchLine } from "../src/bridge.ts";
import { ToolCallError } from "../src/canonical.ts";
import { DISPATCH_EVENT, DISPATCH_LOG_TYPE } from "../src/config.ts";
import { createScheduler } from "../src/scheduler.ts";

test("bridge snapshots args, returns canonical JSON, and records dispatch", async () => {
	const logs: unknown[] = [];
	const events: unknown[] = [];
	const bindings = createCoreBindings({
		execute: async (name, args) => {
			assert.equal(name, "read");
			assert.deepEqual(args, { path: "a.txt" });
			return {
				content: [{ type: "text", text: "hello" }],
				details: { truncation: { truncated: false } },
			};
		},
		scheduler: createScheduler(2),
		appendLog: (entry) => {
			logs.push(entry);
		},
		emit: (name, payload) => {
			events.push({ name, payload });
		},
	});

	const value = await bindings.read({ path: "a.txt" });
	assert.deepEqual(value, { text: "hello", truncation: { truncated: false } });
	assert.deepEqual(logs, [
		{
			customType: DISPATCH_LOG_TYPE,
			name: "read",
			args: { path: "a.txt" },
			isError: false,
		},
	]);
	assert.deepEqual(events, [
		{
			name: DISPATCH_EVENT,
			payload: {
				name: "read",
				args: { path: "a.txt" },
				isError: false,
			},
		},
	]);
});

test("bridge rejects lossless-invalid args before execute", async () => {
	let executed = false;
	const bindings = createCoreBindings({
		execute: async () => {
			executed = true;
			return { content: [] };
		},
		scheduler: createScheduler(2),
	});
	await assert.rejects(
		() => bindings.read({ path: undefined as unknown as string }),
		/lossless JSON/,
	);
	assert.equal(executed, false);
});

test("bridge turns factory failure into ToolCallError", async () => {
	const logs: Array<{ isError: boolean }> = [];
	const bindings = createCoreBindings({
		execute: async () => {
			throw new Error("missing");
		},
		scheduler: createScheduler(2),
		appendLog: (entry) => {
			logs.push({ isError: entry.isError });
		},
	});
	await assert.rejects(
		() => bindings.read({ path: "gone.txt" }),
		(error: unknown) => {
			assert.ok(error instanceof ToolCallError);
			assert.equal(error.toolName, "read");
			assert.equal(error.message, "missing");
			return true;
		},
	);
	assert.deepEqual(logs, [{ isError: true }]);
});

test("bridge classifies exclusive work so bash waits for reads", async () => {
	const started: string[] = [];
	let releaseRead!: () => void;
	const readGate = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	const bindings = createCoreBindings({
		execute: async (name) => {
			started.push(name);
			if (name === "read") await readGate;
			return { content: [{ type: "text", text: name }] };
		},
		scheduler: createScheduler(2),
	});
	const read = bindings.read({ path: "a.txt" });
	const bash = bindings.bash({ command: "true" });
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(started, ["read"]);
	releaseRead();
	await Promise.all([read, bash]);
	assert.deepEqual(started, ["read", "bash"]);
});

test("official executor reads a real file through the factory", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ptc-bridge-"));
	writeFileSync(join(dir, "note.txt"), "factory-ok\n");
	const execute = createOfficialExecutor(dir);
	const bindings = createCoreBindings({
		execute,
		scheduler: createScheduler(2),
	});
	assert.deepEqual(await bindings.read({ path: "note.txt" }), { text: "factory-ok\n" });
});

test("bridge reports start before factory execute and ok after", async () => {
	const order: string[] = [];
	const bindings = createCoreBindings({
		execute: async () => {
			order.push("execute");
			return { content: [{ type: "text", text: "hello" }] };
		},
		scheduler: createScheduler(2),
		reportDispatch: (progress) => {
			order.push(progress.status);
		},
	});
	await bindings.read({ path: "a.txt" });
	assert.deepEqual(order, ["start", "execute", "ok"]);
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
	await assert.rejects(() => bindings.read({ path: "gone.txt" }), ToolCallError);
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
