import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const RETIRED_INTERNAL_PATHS = [
	"../src/bridge.ts",
	"../src/core-bindings.ts",
	"../src/factory-executor.ts",
] as const;

test("package exports only the extension installer", async () => {
	const manifest = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	) as { exports?: Record<string, string>; pi?: { extensions?: string[] } };
	const root = (await import("../index.ts")) as Record<string, unknown>;

	assert.deepEqual(manifest.exports, { ".": "./index.ts" });
	assert.deepEqual(manifest.pi?.extensions, ["./index.ts"]);
	assert.deepEqual(Object.keys(root), ["default"]);
});

test("retired core-only deep routes are absent", () => {
	for (const path of RETIRED_INTERNAL_PATHS) {
		assert.equal(existsSync(new URL(path, import.meta.url)), false, path);
	}
});
