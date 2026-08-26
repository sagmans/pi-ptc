import { strict as assert } from "node:assert";
import test from "node:test";

import { SHIPPED_PTC_CONFIG } from "../src/config.ts";

test("shipped presentation is code", () => {
	assert.equal(SHIPPED_PTC_CONFIG.presentation, "code");
});

test("shipped limits come from config.json", () => {
	assert.equal(SHIPPED_PTC_CONFIG.timeoutMs, 120000);
	assert.equal(SHIPPED_PTC_CONFIG.maxParallelDispatches, 10);
	assert.equal(SHIPPED_PTC_CONFIG.maxOutputBytes, 256000);
	assert.equal(SHIPPED_PTC_CONFIG.maxOutputLines, 10000);
	assert.equal(SHIPPED_PTC_CONFIG.workerMaxOldGenerationSizeMb, 128);
});
