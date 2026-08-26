import { strict as assert } from "node:assert";
import test from "node:test";

import { runCode } from "../src/runtime.ts";

test("runCode returns the program completion value", async () => {
	const outcome = await runCode({ program: "return 1 + 1;" });
	assert.deepEqual(outcome, { logs: [], result: 2 });
});

test("runCode captures console output and a null result", async () => {
	const outcome = await runCode({
		program: 'console.log("x"); return null;',
	});
	assert.deepEqual(outcome, { logs: ["x"], result: null });
});

test("runCode omits result when the program returns undefined", async () => {
	const outcome = await runCode({ program: "return;" });
	assert.deepEqual(outcome, { logs: [] });
});

test("runCode reports a thrown program error", async () => {
	const outcome = await runCode({ program: 'throw new Error("boom");' });
	assert.deepEqual(outcome.error, { kind: "throw", message: "boom" });
});

test("runCode calls host bindings and returns their JSON value", async () => {
	const outcome = await runCode({
		program: "return await tools.echo({ n: 3 });",
		bindings: {
			global: "tools",
			functions: {
				echo: async (args) => args,
			},
		},
		timeoutMs: 1500,
	});
	assert.deepEqual(outcome, { logs: [], result: { n: 3 } });
});

test("runCode rejects binding failures as ToolCallError", async () => {
	const outcome = await runCode({
		program: `
try {
  await tools.fail({ x: 1 });
  return "nope";
} catch (error) {
  return {
    name: error.name,
    toolName: error.toolName,
    isToolCallError: error instanceof ToolCallError,
    message: error.message,
  };
}
`,
		bindings: {
			global: "tools",
			functions: {
				fail: async () => {
					throw Object.assign(new Error("denied"), { toolName: "fail" });
				},
			},
		},
	});
	assert.deepEqual(outcome, {
		logs: [],
		result: {
			name: "ToolCallError",
			toolName: "fail",
			isToolCallError: true,
			message: "denied",
		},
	});
});

test("runCode aborts an in-flight program", async () => {
	const controller = new AbortController();
	const pending = runCode({
		program: "await tools.hang(null); return 1;",
		bindings: {
			global: "tools",
			functions: {
				hang: () => new Promise(() => undefined),
			},
		},
		signal: controller.signal,
	});
	controller.abort();
	const outcome = await pending;
	assert.deepEqual(outcome.error, { kind: "abort" });
});

test("runCode times out a hanging program", async () => {
	const outcome = await runCode({
		program: "await tools.hang(null); return 1;",
		bindings: {
			global: "tools",
			functions: {
				hang: () => new Promise(() => undefined),
			},
		},
		timeoutMs: 20,
	});
	assert.deepEqual(outcome.error, { kind: "timeout" });
});

test("runCode terminates when serialized logs exceed the byte limit", async () => {
	const outcome = await runCode({
		program: 'console.log("12345"); return 1;',
		maxOutputBytes: 17,
		maxOutputLines: 2000,
	});
	assert.deepEqual(outcome, { logs: [], error: { kind: "output-limit" } });
});

test("runCode terminates when logs exceed the logical line limit", async () => {
	const outcome = await runCode({
		program: 'console.log("one"); console.log("two"); console.log("three"); return 1;',
		maxOutputBytes: 51200,
		maxOutputLines: 2,
	});
	assert.deepEqual(outcome, {
		logs: ["one", "two"],
		error: { kind: "output-limit" },
	});
});

test("runCode starts workers with an empty environment", async () => {
	const outcome = await runCode({ program: "return Object.keys(process.env);" });
	assert.deepEqual(outcome, { logs: [], result: [] });
});
