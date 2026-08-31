import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const AUTHORED_FILE_MAXIMUM_LINES = 499;
const REJECTED_FIXTURE_LINES = AUTHORED_FILE_MAXIMUM_LINES + 1;
const REPOSITORY_ROOT = new URL("..", import.meta.url);
const TEMPORARY_DIRECTORY_PREFIX = "pi-ptc-authored-lines-";
const AUTHORED_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".json", ".mjs", ".mts", ".ts"]);
const EXCLUDED_DIRECTORIES = new Set([".git", ".npm", "coverage", "dist", "node_modules", "out"]);
const EXCLUDED_PATHS = new Set(["package-lock.json"]);
const EXCLUDED_PREFIXES = ["test/fixtures/"];

function repositoryPath(path: string): string {
	return path.split(sep).join("/");
}

function physicalLineCount(contents: string): number {
	if (contents.length === 0) return 0;
	const breaks = contents.match(/\r\n|\r|\n/g)?.length ?? 0;
	return breaks + (contents.endsWith("\n") || contents.endsWith("\r") ? 0 : 1);
}

function isExcluded(path: string): boolean {
	return EXCLUDED_PATHS.has(path) || EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function collectAuthoredFiles(root: string, directory = root): string[] {
	const paths: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) continue;
		const absolutePath = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
				paths.push(...collectAuthoredFiles(root, absolutePath));
			}
			continue;
		}
		const path = repositoryPath(relative(root, absolutePath));
		if (entry.isFile() && AUTHORED_EXTENSIONS.has(extname(entry.name)) && !isExcluded(path)) {
			paths.push(path);
		}
	}
	return paths.sort();
}

function assertAuthoredLineBounds(root: string): void {
	const failures: string[] = [];
	for (const path of collectAuthoredFiles(root)) {
		const lines = physicalLineCount(readFileSync(join(root, path), "utf8"));
		if (lines > AUTHORED_FILE_MAXIMUM_LINES) {
			failures.push(`${path}: ${lines} physical lines exceeds ${AUTHORED_FILE_MAXIMUM_LINES}`);
		}
	}
	assert.deepEqual(failures, []);
}

test("every authored file stays below 500 physical lines", () => {
	const root = relative(process.cwd(), fileURLToPath(REPOSITORY_ROOT)) || ".";
	assertAuthoredLineBounds(root);
});

test("authored-line detector rejects a 500-line temporary fixture", () => {
	const directory = mkdtempSync(join(tmpdir(), TEMPORARY_DIRECTORY_PREFIX));
	try {
		writeFileSync(join(directory, "fixture.ts"), "export {};\n".repeat(REJECTED_FIXTURE_LINES));
		assert.throws(
			() => assertAuthoredLineBounds(directory),
			/fixture\.ts: 500 physical lines exceeds 499/,
		);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});
