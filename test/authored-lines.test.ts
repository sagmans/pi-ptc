import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PLANNING_BASELINE_COMMIT = "73b7ce74c549a4a5169cd67d6d5dc9312852db5a";
const NEW_FILE_MAXIMUM_LINES = 449;
const AUTHORED_FILE_MAXIMUM_LINES = 499;
const REJECTED_FIXTURE_LINES = 500;
const GIT_TIMEOUT_MS = 10_000;
const REPOSITORY_ROOT = new URL("..", import.meta.url);
const TEMPORARY_DIRECTORY_PREFIX = "pi-ptc-authored-lines-";
const AUTHORED_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".json", ".mjs", ".mts", ".ts"]);
const EXCLUDED_DIRECTORIES = new Set([".git", ".npm", "coverage", "dist", "node_modules", "out"]);
const EXCLUDED_PATHS = new Set(["package-lock.json"]);
const EXCLUDED_PREFIXES = ["test/fixtures/"];
const BASELINE_VIOLATIONS = new Map<string, number>([
	["src/index.ts", 540],
	["src/pi-runtime.ts", 2_266],
	["src/tool-executor.ts", 732],
	["test/bridge.test.ts", 1_002],
	["test/dispatch-details.test.ts", 751],
	["test/index.test.ts", 2_523],
	["test/pi-runtime.test.ts", 3_161],
	["test/renderer.test.ts", 1_989],
	["test/runtime.test.ts", 706],
	["test/tool-executor.test.ts", 1_129],
	["test/transport.test.ts", 1_494],
]);

type AuthoredLinePolicy = {
	readonly baselinePaths: ReadonlySet<string>;
	readonly baselineViolations: ReadonlyMap<string, number>;
};

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

function assertAuthoredLineBounds(root: string, policy: AuthoredLinePolicy): void {
	const failures: string[] = [];
	for (const path of collectAuthoredFiles(root)) {
		const lines = physicalLineCount(readFileSync(join(root, path), "utf8"));
		const baselineLimit = policy.baselineViolations.get(path);
		const limit =
			baselineLimit ??
			(policy.baselinePaths.has(path) ? AUTHORED_FILE_MAXIMUM_LINES : NEW_FILE_MAXIMUM_LINES);
		if (lines > limit) failures.push(`${path}: ${lines} physical lines exceeds ${limit}`);
	}
	assert.deepEqual(failures, []);
}

function loadBaselinePaths(root: string): ReadonlySet<string> {
	const output = execFileSync("git", ["ls-tree", "-r", "--name-only", PLANNING_BASELINE_COMMIT], {
		cwd: root,
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
	});
	return new Set(output.split("\n").filter(Boolean));
}

test("authored files respect transitional decomposition bounds", () => {
	const root = relative(process.cwd(), fileURLToPath(REPOSITORY_ROOT)) || ".";
	assertAuthoredLineBounds(root, {
		baselinePaths: loadBaselinePaths(root),
		baselineViolations: BASELINE_VIOLATIONS,
	});
});

test("authored-line detector rejects a 500-line temporary fixture", () => {
	const directory = mkdtempSync(join(tmpdir(), TEMPORARY_DIRECTORY_PREFIX));
	try {
		writeFileSync(join(directory, "fixture.ts"), "export {};\n".repeat(REJECTED_FIXTURE_LINES));
		assert.throws(
			() =>
				assertAuthoredLineBounds(directory, {
					baselinePaths: new Set(),
					baselineViolations: new Map(),
				}),
			/fixture\.ts: 500 physical lines exceeds 449/,
		);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});
