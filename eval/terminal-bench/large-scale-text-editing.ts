// Adapted from Terminal-Bench 2.1 large-scale-text-editing.
// Source provenance stays explicit because benchmark behavior must remain auditable.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const INPUT_FILE_NAME = "input.csv";
const EXPECTED_FILE_NAME = "expected.csv";
const MACRO_FILE_NAME = "apply_macros.vim";
const KEYSTROKE_OUTPUT_FILE_NAME = "vim_keystrokes.out";
const REGISTER_OUTPUT_FILE_NAME = "vim_regs.out";
const DEFINITION_SCRIPT_FILE_NAME = "definitions.vim";
const WRITE_BATCH_ROWS = 10_000;
const MAX_KEYSTROKES = 200;
const VIM_TIMEOUT_MS = 600_000;
const VIM_COMMAND = "vim";
const REGISTER_NAMES = ["a", "b", "c"];
const PADDING = [" ", "  ", "   "];
const ROW_VALUES = [
	["first", "seCond", "third"],
	["alpha", "BeTa", "GaMmA"],
	["lorem", "IpsUm", "dolor"],
	["north", "EaSt", "west"],
	["begin", "MiDdLe", "end"],
];
const EXIT_COMMANDS = new Set([":wq", ":x"]);
const EXECUTION_PATTERN = /^:%normal! @([abc])$/;
const DEFINITION_PATTERN = /^:?call setreg\(['"]([abc])['"],\s*(['"])([^'"]*)\2\)$/;
const FORBIDDEN_KEYSTROKE_PATTERNS = [
	/:(\d*|[$%+\-.]|(\d+,\d*)|(\d*,\$))*(r|read|source|so|e|edit|sp|split|vs|vsplit|tabe|tabedit|new|vnew)\b/i,
	/system\(/i,
	/glob\(/i,
	/expand\(/i,
	/executable\(/i,
	/filereadable\(/i,
	/function\s*!/i,
	/let\s+/i,
	/eval\s*\(/i,
	/:py\b/i,
	/:lua\b/i,
	/:perl\b/i,
	/:ruby\b/i,
	/:!\w/i,
];

export type LargeScaleTextEditingResult = {
	correct: boolean;
	reason: string;
	keystrokes?: number;
};

export type LargeScaleTextEditingValidation =
	| { ok: false; reason: string }
	| { ok: true; definitions: string[] };

function assertRowCount(rowCount: number): void {
	if (!Number.isSafeInteger(rowCount) || rowCount < 1) {
		throw new Error("large-scale text editing row count must be a positive safe integer");
	}
}

function rowValues(index: number): [string, string, string] {
	const [first, second, third] = ROW_VALUES[index % ROW_VALUES.length];
	return [first + index, second + index, third + index];
}

function spaced(value: string, index: number): string {
	return PADDING[index % PADDING.length] + value + PADDING[Math.floor(index / 2) % PADDING.length];
}

function inputRow(index: number): string {
	const [first, second, third] = rowValues(index);
	return `${[spaced(first, index), spaced(second, index + 1), spaced(third, index + 2)].join(" , ")}\n`;
}

function expectedRow(index: number): string {
	const [first, second, third] = rowValues(index);
	return `${third.toUpperCase()};${second.toUpperCase()};${first.toUpperCase()};OK\n`;
}

function rows(start: number, end: number, render: (index: number) => string): string {
	const batch: string[] = [];
	for (let index = start; index < end; index += 1) batch.push(render(index));
	return batch.join("");
}

async function writeInput(path: string, rowCount: number): Promise<void> {
	// Remove first because exclusive creation prevents a stale symlink from redirecting verifier writes.
	await rm(path, { force: true });
	const handle = await open(path, "wx");
	try {
		for (let start = 1; start <= rowCount; start += WRITE_BATCH_ROWS) {
			const end = Math.min(start + WRITE_BATCH_ROWS, rowCount + 1);
			await handle.write(rows(start, end, inputRow));
		}
	} finally {
		await handle.close();
	}
}

export async function materializeLargeScaleTextEditing(
	directory: string,
	rowCount: number,
): Promise<void> {
	assertRowCount(rowCount);
	await mkdir(directory, { recursive: true });
	await rm(join(directory, EXPECTED_FILE_NAME), { force: true });
	await writeInput(join(directory, INPUT_FILE_NAME), rowCount);
}

function scriptLines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith('"'));
}

export function validateLargeScaleTextEditingScript(text: string): LargeScaleTextEditingValidation {
	const definitions = new Map<string, string>();
	const executions = new Set<string>();
	let hasExit = false;
	for (const [index, line] of scriptLines(text).entries()) {
		if (EXIT_COMMANDS.has(line)) {
			hasExit = true;
			continue;
		}
		const execution = line.match(EXECUTION_PATTERN);
		if (execution) {
			executions.add(execution[1]);
			continue;
		}
		const definition = line.match(DEFINITION_PATTERN);
		if (!definition) return { ok: false, reason: `invalid command on line ${index + 1}` };
		const [, register, , keystrokes] = definition;
		if (FORBIDDEN_KEYSTROKE_PATTERNS.some((pattern) => pattern.test(keystrokes))) {
			return { ok: false, reason: `invalid command in macro ${register}` };
		}
		definitions.set(register, line);
	}
	if (!hasExit) return { ok: false, reason: "missing :wq or :x" };
	if (REGISTER_NAMES.some((register) => !definitions.has(register))) {
		return { ok: false, reason: "must define macros a, b, and c" };
	}
	if (REGISTER_NAMES.some((register) => !executions.has(register))) {
		return { ok: false, reason: "must execute macros a, b, and c" };
	}
	return {
		ok: true,
		definitions: REGISTER_NAMES.map((register) => definitions.get(register) ?? ""),
	};
}

function definitionInspectionScript(definitions: readonly string[]): string {
	return [
		...definitions,
		"function! Count(reg) abort",
		"  let s = keytrans(getreg(a:reg))",
		"  let s = substitute(s, '<[^>]\\+>', \"\\x01\", 'g')",
		"  return strlen(s)",
		"endfunction",
		"let ra = keytrans(getreg('a'))",
		"let rb = keytrans(getreg('b'))",
		"let rc = keytrans(getreg('c'))",
		"let ka = Count('a')",
		"let kb = Count('b')",
		"let kc = Count('c')",
		"let kt = ka + kb + kc",
		`call writefile([printf('KEYSTROKES a=%d b=%d c=%d total=%d', ka, kb, kc, kt)], '${KEYSTROKE_OUTPUT_FILE_NAME}', 'w')`,
		`call writefile([ra, rb, rc], '${REGISTER_OUTPUT_FILE_NAME}', 'w')`,
		"qa!",
	].join("\n");
}

async function inspectDefinitions(definitions: readonly string[]): Promise<{
	counts: number[];
	registers: string[];
}> {
	const directory = await mkdtemp(join(tmpdir(), "pi-ptc-vim-definitions-"));
	try {
		const scriptPath = join(directory, DEFINITION_SCRIPT_FILE_NAME);
		await writeFile(scriptPath, definitionInspectionScript(definitions), "utf8");
		await execFileAsync(VIM_COMMAND, ["-Nu", "NONE", "-n", "-Es", "-S", scriptPath], {
			cwd: directory,
			timeout: VIM_TIMEOUT_MS,
		});
		const countText = (await readFile(join(directory, KEYSTROKE_OUTPUT_FILE_NAME), "utf8")).trim();
		const countMatch = countText.match(/^KEYSTROKES a=(\d+) b=(\d+) c=(\d+) total=(\d+)$/);
		if (!countMatch) throw new Error("could not parse Vim keystroke count");
		const counts = countMatch.slice(1).map(Number);
		const registers = (await readFile(join(directory, REGISTER_OUTPUT_FILE_NAME), "utf8"))
			.split(/\r?\n/)
			.slice(0, REGISTER_NAMES.length);
		return { counts, registers };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

function expectedHash(rowCount: number): string {
	const hash = createHash("sha256");
	for (let start = 1; start <= rowCount; start += WRITE_BATCH_ROWS) {
		const end = Math.min(start + WRITE_BATCH_ROWS, rowCount + 1);
		hash.update(rows(start, end, expectedRow));
	}
	return hash.digest("hex");
}

function failure(reason: string, keystrokes?: number): LargeScaleTextEditingResult {
	return keystrokes === undefined
		? { correct: false, reason }
		: { correct: false, reason, keystrokes };
}

export async function judgeLargeScaleTextEditing(
	directory: string,
	rowCount: number,
): Promise<LargeScaleTextEditingResult> {
	assertRowCount(rowCount);
	let text: string;
	try {
		text = await readFile(join(directory, MACRO_FILE_NAME), "utf8");
	} catch {
		return failure(`missing ${MACRO_FILE_NAME}`);
	}
	const validation = validateLargeScaleTextEditingScript(text);
	if (!validation.ok) return failure(validation.reason);
	let inspection: Awaited<ReturnType<typeof inspectDefinitions>>;
	try {
		inspection = await inspectDefinitions(validation.definitions);
	} catch {
		return failure("could not inspect Vim macro definitions");
	}
	const [a, b, c, total] = inspection.counts;
	if (a < 1 || b < 1 || c < 1) return failure("macros must be non-empty", total);
	if (total !== a + b + c || total >= MAX_KEYSTROKES) {
		return failure(`total macro keystrokes must be less than ${MAX_KEYSTROKES}`, total);
	}
	if (new Set(inspection.registers).size !== REGISTER_NAMES.length) {
		return failure("macros a, b, and c must be distinct", total);
	}
	await materializeLargeScaleTextEditing(directory, rowCount);
	try {
		await execFileAsync(
			VIM_COMMAND,
			["-Nu", "NONE", "-n", "-Es", INPUT_FILE_NAME, "-S", MACRO_FILE_NAME],
			{
				cwd: directory,
				timeout: VIM_TIMEOUT_MS,
			},
		);
	} catch {
		return failure("Vim failed to apply the macro script", total);
	}
	const actual = await hashFile(join(directory, INPUT_FILE_NAME));
	const expected = expectedHash(rowCount);
	if (actual !== expected)
		return failure("transformed input.csv does not match expected output", total);
	return { correct: true, reason: "workspace verifier passed", keystrokes: total };
}
