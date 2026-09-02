import { strict as assert } from "node:assert";
import test from "node:test";

import { ToolResultDeliveryError } from "../src/canonical.ts";
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

test("runCode distinguishes transform, compilation, and runtime failures", async (t) => {
	await t.test("transform", async () => {
		const outcome = await runCode({ program: "return (;" });
		assert.equal(outcome.error?.kind, "program-transform");
	});

	await t.test("compile", async () => {
		const outcome = await runCode({ program: "return import.meta;" });
		assert.equal(outcome.error?.kind, "program-compile");
	});

	await t.test("runtime", async () => {
		const outcome = await runCode({ program: 'throw new Error("boom");' });
		assert.deepEqual(outcome.error, { kind: "program-runtime", message: "boom" });
	});
});

test("runCode calls host bindings and returns their JSON value", async () => {
	const outcome = await runCode({
		program: "return await tools.echo({ n: 3 });",
		bindings: {
			functions: {
				echo: async (args) => args,
			},
		},
		timeoutMs: 1500,
	});
	assert.deepEqual(outcome, { logs: [], result: { n: 3 } });
});

test("runCode exposes ToolResultDeliveryError to program code", async () => {
	const outcome = await runCode({
		program: `
try {
  await tools.fail({});
  return "nope";
} catch (error) {
  return {
    isDeliveryError: error instanceof ToolResultDeliveryError,
    retryUnsafe: error.retryUnsafe,
  };
}
`,
		bindings: {
			functions: {
				fail: async () => {
					throw new ToolResultDeliveryError("fail", "delivery failed");
				},
			},
		},
	});
	assert.deepEqual(outcome, {
		logs: [],
		result: { isDeliveryError: true, retryUnsafe: true },
	});
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
