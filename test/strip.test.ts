import { strict as assert } from "node:assert";
import test from "node:test";

import { resolveStripFn } from "../src/strip.ts";

const TYPED = `async function __ptc_main__(tools, ToolCallError, console) {
	const n: number = 2;
	return n;
}`;

test("resolveStripFn uses the Bun transpiler when Node strip is missing", () => {
	const strip = resolveStripFn({
		nodeStrip: undefined,
		bunTranspiler: class {
			transformSync(source: string): string {
				return source.replace(": number", "");
			}
		},
	});
	const js = strip(TYPED);
	assert.equal(js.includes(": number"), false);
	const create = new Function(`${js}\nreturn __ptc_main__;`) as () => (
		tools: unknown,
		error: unknown,
		console: unknown,
	) => Promise<number>;
	assert.equal(typeof create(), "function");
});

test("resolveStripFn fails closed when no stripper exists", () => {
	assert.throws(() => resolveStripFn({}), /no TypeScript stripper/);
});
