import { strict as assert } from "node:assert";
import test from "node:test";
import { createFactoryExecutor } from "../src/bridge.ts";
import { fakeFactoryTools } from "./support/tool-bindings-harness.ts";

test("factory executor reserves unique IDs before concurrent calls settle", async () => {
	const ids: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const execute = createFactoryExecutor(
		fakeFactoryTools(async (id) => {
			ids.push(id);
			if (ids.length === 1) await gate;
			return { content: [{ type: "text", text: "ok" }] };
		}),
	);

	const first = execute("read", { path: "a.txt" });
	const second = execute("read", { path: "b.txt" });
	assert.deepEqual(ids, ["ptc:read:1", "ptc:read:2"]);
	release();
	await Promise.all([first, second]);
});

test("factory executor does not reuse an ID after failure", async () => {
	const ids: string[] = [];
	const execute = createFactoryExecutor(
		fakeFactoryTools(async (id) => {
			ids.push(id);
			if (ids.length === 1) throw new Error("failed");
			return { content: [{ type: "text", text: "ok" }] };
		}),
	);

	await assert.rejects(() => execute("read", { path: "a.txt" }), /failed/);
	await execute("read", { path: "b.txt" });
	assert.deepEqual(ids, ["ptc:read:1", "ptc:read:2"]);
});
