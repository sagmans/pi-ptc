import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { parseTarballArgument, validateTarballPath } from "../scripts/smoke-package.mjs";

const ABSOLUTE_TARBALL = "/tmp/sagmans-pi-ptc-0.1.0.tgz";
const PACKAGE_NAME = "@sagmans/pi-ptc";
const PACKED_WORKER_PATH = "worker-dist/worker.js";
const TEST_LIFECYCLE = "test";
const NPM_BINARY = process.platform === "win32" ? "npm.cmd" : "npm";
const TEST_TIMEOUT_MS = 120_000;
const WORKER_LIMIT = 1024;
const WORKER_PROGRAM =
	"async function __ptc_main__(tools, ToolCallError, ToolResultDeliveryError, console) { return { ok: true }; }";

test("package smoke accepts one absolute tarball", () => {
	assert.equal(validateTarballPath(ABSOLUTE_TARBALL), ABSOLUTE_TARBALL);
	assert.equal(parseTarballArgument(["--tarball", ABSOLUTE_TARBALL]), ABSOLUTE_TARBALL);
});

test("package smoke rejects relative and ambiguous tarball input", () => {
	assert.throws(() => validateTarballPath("relative.tgz"), /absolute/u);
	assert.throws(() => validateTarballPath("/tmp/package.zip"), /\.tgz/u);
	assert.equal(parseTarballArgument([]), undefined);
	assert.throws(() => parseTarballArgument(["--tarball", ABSOLUTE_TARBALL, "extra"]), /Usage/u);
});

test("packed worker executes from an npm installation", { timeout: TEST_TIMEOUT_MS }, async () => {
	const scratch = await mkdtemp(path.join(tmpdir(), "pi-ptc-packed-worker-test-"));
	try {
		const artifactDirectory = path.join(scratch, "artifact");
		const installDirectory = path.join(scratch, "install");
		await Promise.all([mkdir(artifactDirectory), mkdir(installDirectory)]);
		if (process.env.npm_lifecycle_event !== TEST_LIFECYCLE) {
			const build = spawnSync(NPM_BINARY, ["run", "prepack"], { encoding: "utf8" });
			assert.equal(build.status, 0, build.stderr);
		}
		const pack = spawnSync(
			NPM_BINARY,
			["pack", "--ignore-scripts", "--pack-destination", artifactDirectory],
			{
				cwd: process.cwd(),
				encoding: "utf8",
			},
		);
		assert.equal(pack.status, 0, pack.stderr);
		const tarballName = pack.stdout.trim().split(/\r?\n/u).at(-1);
		assert.ok(tarballName);
		const tarball = path.join(artifactDirectory, tarballName);
		const install = spawnSync(
			NPM_BINARY,
			["install", "--ignore-scripts", "--omit=peer", "--prefix", installDirectory, tarball],
			{ encoding: "utf8" },
		);
		assert.equal(install.status, 0, install.stderr);
		const workerPath = path.join(
			installDirectory,
			"node_modules",
			PACKAGE_NAME,
			PACKED_WORKER_PATH,
		);
		const worker = new Worker(workerPath, {
			workerData: {
				program: WORKER_PROGRAM,
				bindingNames: [],
				maxOutputBytes: WORKER_LIMIT,
				maxOutputLines: WORKER_LIMIT,
			},
		});
		const [message] = await once(worker, "message");
		assert.deepEqual(message, { type: "done", value: { ok: true } });
		await worker.terminate();
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});
