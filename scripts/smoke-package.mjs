import { execFile } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";

const execFileAsync = promisify(execFile);
const COMMAND_ENCODING = "utf8";
const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_MAX_BUFFER_BYTES = 1_000_000;
const PACKAGE_MANIFEST = "package.json";
const PACKAGE_ENTRY = "index.ts";
const PACKED_WORKER_ENTRY = "worker-dist/worker.js";
const WORKER_PROGRAM =
	"async function __ptc_main__(tools, ToolCallError, ToolResultDeliveryError, console) { return { ok: true }; }";
const WORKER_LIMIT = 1024;
const WORKER_RESULT = { type: "done", value: { ok: true } };
const TARBALL_EXTENSION = ".tgz";
const TEMP_PREFIX = "pi-ptc-package-smoke-";
const INSTALL_DIRECTORY = "install";
const ARTIFACT_DIRECTORY = "artifact";
const PI_PACKAGE = "@earendil-works/pi-coding-agent@0.84.4";
const PI_BINARY = process.platform === "win32" ? "pi.cmd" : "pi";
const NPM_BINARY = process.platform === "win32" ? "npm.cmd" : "npm";
const EXTENSION_ERROR = /(?:failed to load extension|extension error)/iu;
const USAGE = "Usage: node scripts/smoke-package.mjs --tarball /absolute/package.tgz";

export function validateTarballPath(tarballPath) {
	if (!isAbsolute(tarballPath)) throw new Error("Tarball path must be absolute");
	if (!tarballPath.endsWith(TARBALL_EXTENSION)) {
		throw new Error(`Tarball path must end with ${TARBALL_EXTENSION}`);
	}
	return tarballPath;
}

export function parseTarballArgument(args) {
	if (args.length === 0) return undefined;
	if (args.length === 2 && args[0] === "--tarball") return validateTarballPath(args[1]);
	throw new Error(USAGE);
}

async function run(command, args, options = {}) {
	try {
		const result = await execFileAsync(command, args, {
			cwd: options.cwd,
			env: options.env,
			encoding: COMMAND_ENCODING,
			maxBuffer: COMMAND_MAX_BUFFER_BYTES,
			timeout: COMMAND_TIMEOUT_MS,
		});
		return { code: 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		return {
			code: typeof error.code === "number" ? error.code : 1,
			stdout: typeof error.stdout === "string" ? error.stdout : "",
			stderr: typeof error.stderr === "string" ? error.stderr : String(error),
		};
	}
}

function requireSuccess(result, label) {
	if (result.code !== 0) throw new Error(`${label} failed: ${result.stderr.trim()}`);
}

async function exercisePackedWorker(workerPath) {
	const worker = new Worker(workerPath, {
		workerData: {
			program: WORKER_PROGRAM,
			bindingNames: [],
			maxOutputBytes: WORKER_LIMIT,
			maxOutputLines: WORKER_LIMIT,
		},
	});
	try {
		const [message] = await once(worker, "message");
		if (JSON.stringify(message) !== JSON.stringify(WORKER_RESULT)) {
			throw new Error("Installed worker returned an unexpected result");
		}
	} finally {
		await worker.terminate();
	}
}

export async function smokePackage(tarballPath, rootDirectory = process.cwd()) {
	const temporaryRoot = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
	try {
		let tarball;
		if (tarballPath === undefined) {
			const artifactDirectory = join(temporaryRoot, ARTIFACT_DIRECTORY);
			await mkdir(artifactDirectory);
			const pack = await run(NPM_BINARY, ["pack", "--pack-destination", artifactDirectory], {
				cwd: rootDirectory,
			});
			requireSuccess(pack, "npm pack");
			const archives = (await readdir(artifactDirectory)).filter((name) =>
				name.endsWith(TARBALL_EXTENSION),
			);
			if (archives.length !== 1) {
				throw new Error(`Expected exactly one package tarball, found ${archives.length}`);
			}
			tarball = join(artifactDirectory, archives[0]);
		} else {
			tarball = validateTarballPath(tarballPath);
			await access(tarball);
		}

		const installRoot = join(temporaryRoot, INSTALL_DIRECTORY);
		await mkdir(installRoot);
		const install = await run(
			NPM_BINARY,
			["install", "--ignore-scripts", "--prefix", installRoot, tarball, PI_PACKAGE],
			{ cwd: rootDirectory },
		);
		requireSuccess(install, "isolated package install");

		const manifest = JSON.parse(
			await readFile(join(rootDirectory, PACKAGE_MANIFEST), COMMAND_ENCODING),
		);
		if (typeof manifest.name !== "string" || manifest.name.length === 0) {
			throw new Error("Root package manifest must declare a package name");
		}
		const nodeModules = join(installRoot, "node_modules");
		const packageRoot = join(nodeModules, manifest.name);
		const entryPath = join(packageRoot, PACKAGE_ENTRY);
		const workerPath = join(packageRoot, PACKED_WORKER_ENTRY);
		const piPath = join(nodeModules, ".bin", PI_BINARY);
		await Promise.all([access(entryPath), access(workerPath), access(piPath)]);
		await exercisePackedWorker(workerPath);

		const isolatedAgentDirectory = join(temporaryRoot, "agent");
		await mkdir(isolatedAgentDirectory);
		const load = await run(
			piPath,
			[
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--extension",
				entryPath,
				"--list-models",
			],
			{
				cwd: temporaryRoot,
				env: {
					...process.env,
					HOME: temporaryRoot,
					PI_CODING_AGENT_DIR: isolatedAgentDirectory,
				},
			},
		);
		requireSuccess(load, "Pi extension load");
		if (EXTENSION_ERROR.test(`${load.stdout}\n${load.stderr}`)) {
			throw new Error("Pi reported an extension loading error");
		}
		return entryPath;
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

async function main() {
	const entryPath = await smokePackage(parseTarballArgument(process.argv.slice(2)));
	console.log(`Pi loaded package entry: ${entryPath}`);
}

const isMain =
	process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) await main();
