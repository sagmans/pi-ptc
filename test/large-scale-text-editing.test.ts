import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { judgeCaseResult, loadCaseDefinition, materializeCase } from "../eval/case-definition.ts";
import { validateLargeScaleTextEditingScript } from "../eval/terminal-bench/large-scale-text-editing.ts";

const CASES_DIRECTORY = new URL("../eval/cases/", import.meta.url);

test("large-scale text editing materializes deterministic input without the answer", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-ptc-eval-large-edit-"));
	try {
		const definition = await loadCaseDefinition("large-scale-text-editing", CASES_DIRECTORY);
		if (definition.judge !== "large-scale-text-editing") assert.fail("unexpected case judge");
		await materializeCase({ ...definition, rowCount: 3 }, directory, "code");
		const input = readFileSync(join(directory, "input.csv"), "utf8");
		assert.equal(input.split("\n").length - 1, 3);
		assert.equal(input.split("\n")[0], "  alpha1  ,    BeTa1   ,  GaMmA1  ");
		assert.equal(existsSync(join(directory, "expected.csv")), false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("large-scale text editing rejects commands outside the upstream constraints", () => {
	const result = validateLargeScaleTextEditingScript(":!cp expected.csv input.csv\n:wq\n");
	assert.equal(result.ok, false);
	assert.match(result.reason, /invalid command/i);
});

test("large-scale text editing verifies a valid macro transformation against fresh input", {
	skip: spawnSync("vim", ["--version"]).status !== 0,
}, async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-ptc-eval-large-edit-"));
	try {
		const definition = await loadCaseDefinition("large-scale-text-editing", CASES_DIRECTORY);
		if (definition.judge !== "large-scale-text-editing") assert.fail("unexpected case judge");
		const smallDefinition = { ...definition, rowCount: 20 } as const;
		await materializeCase(smallDefinition, directory, "code");
		writeFileSync(
			join(directory, "apply_macros.vim"),
			String.raw`call setreg('a', ":s/\\s*,\\s*/,/g\<CR>:s/^\\s*\\(.*\\S\\)\\s*$/\\1/\<CR>j")
call setreg('b', ":s/^\\([^,]*\\),\\([^,]*\\),\\([^,]*\\)$/\\3,\\2,\\1/\<CR>j")
call setreg('c', ":s/^\\([^,]*\\),\\([^,]*\\),\\([^,]*\\)$/\\U\\1\\E,\\U\\2\\E,\\U\\3\\E/\<CR>:s/,/;/g\<CR>:s/$/;OK/\<CR>j")
:%normal! @a
:%normal! @b
:%normal! @c
:wq`,
			"utf8",
		);
		const result = await judgeCaseResult(smallDefinition, undefined, directory);
		assert.equal(result.correct, true, result.reason);
		assert.equal(typeof result.keystrokes, "number");
		assert.ok((result.keystrokes ?? Number.POSITIVE_INFINITY) < 200);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
