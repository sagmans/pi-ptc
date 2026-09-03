import { strict as assert } from "node:assert";
import test from "node:test";

import { SHIPPED_PTC_CONFIG } from "../src/config.ts";

test("shipped presentation is code", () => {
	assert.equal(SHIPPED_PTC_CONFIG.presentation, "code");
});

test("shipped limits come from config.json", () => {
	assert.equal(Object.hasOwn(SHIPPED_PTC_CONFIG, "timeoutMs"), false);
	assert.equal(SHIPPED_PTC_CONFIG.drainTimeoutMs, 5000);
	assert.equal(SHIPPED_PTC_CONFIG.maxOrphanedBindings, 100);
	assert.equal(SHIPPED_PTC_CONFIG.maxParallelDispatches, 10);
	assert.equal(SHIPPED_PTC_CONFIG.maxDispatches, 100);
	assert.equal(SHIPPED_PTC_CONFIG.maxToolUpdatesPerDispatch, 100);
	assert.equal(SHIPPED_PTC_CONFIG.maxRenderDetailsBytes, 2_000_000);
	assert.equal(SHIPPED_PTC_CONFIG.maxPersistedDetailsBytes, 3_000_000);
	assert.equal(SHIPPED_PTC_CONFIG.maxOutputBytes, 256000);
	assert.equal(SHIPPED_PTC_CONFIG.maxOutputLines, 10000);
	assert.equal(SHIPPED_PTC_CONFIG.workerMaxOldGenerationSizeMb, 128);
});
