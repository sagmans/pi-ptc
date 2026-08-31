import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BASELINE_COMMIT = "73b7ce74c549a4a5169cd67d6d5dc9312852db5a";
const CHILD_PROCESS_TIMEOUT_MS = 30_000;
const CHILD_PROCESS_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const TEMPORARY_DIRECTORY_PREFIX = "pi-ptc-baseline-";
const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CURRENT_NODE_MODULES = join(REPOSITORY_ROOT, "node_modules");

function resolveBaselinePath(root: string, path: string): string {
	if (isAbsolute(path)) throw new TypeError("Baseline module path must be repository-relative");
	const resolved = join(root, normalize(path));
	const relation = relative(root, resolved);
	if (relation.startsWith("..") || isAbsolute(relation)) {
		throw new TypeError("Baseline module path must stay inside the baseline checkout");
	}
	return resolved;
}

export async function loadBaselineModule(path: string): Promise<unknown> {
	const directory = mkdtempSync(join(tmpdir(), TEMPORARY_DIRECTORY_PREFIX));
	try {
		const archive = execFileSync("git", ["archive", "--format=tar", BASELINE_COMMIT], {
			cwd: REPOSITORY_ROOT,
			maxBuffer: CHILD_PROCESS_MAX_BUFFER_BYTES,
			timeout: CHILD_PROCESS_TIMEOUT_MS,
		});
		execFileSync("tar", ["-x", "-C", directory], {
			input: archive,
			maxBuffer: CHILD_PROCESS_MAX_BUFFER_BYTES,
			timeout: CHILD_PROCESS_TIMEOUT_MS,
		});
		if (existsSync(CURRENT_NODE_MODULES)) {
			symlinkSync(CURRENT_NODE_MODULES, join(directory, "node_modules"), "dir");
		}
		const modulePath = resolveBaselinePath(directory, path);
		return await import(`${pathToFileURL(modulePath).href}?baseline=${BASELINE_COMMIT}`);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
}
