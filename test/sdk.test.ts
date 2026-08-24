import { strict as assert } from "node:assert";
import test from "node:test";

import { CORE_TOOL_NAMES } from "../src/config.ts";
import { renderSdkPrompt } from "../src/sdk.ts";

test("sdk prompt lists bindings in lexicographic order", () => {
	const prompt = renderSdkPrompt();
	const indexes = CORE_TOOL_NAMES.map((name) => prompt.indexOf(`await tools.${name}(`));
	assert.ok(indexes.every((index) => index >= 0));
	assert.deepEqual(
		indexes,
		[...indexes].sort((left, right) => left - right),
	);
});

test("sdk prompt is byte-stable and names the v1 contracts", () => {
	const prompt = renderSdkPrompt();
	assert.equal(prompt, renderSdkPrompt());
	assert.match(prompt, /erasable TypeScript only/);
	assert.match(prompt, /tools\.read/);
	assert.match(prompt, /ToolCallError/);
	assert.match(prompt, /Promise\.all/);
	assert.match(prompt, /\/skill:/);
});
