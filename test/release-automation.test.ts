import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const SCRIPT_PATH = path.resolve("scripts/npm/bootstrap-publish.sh");
const EXPECTED_ACCOUNT = "sagmans";
const PACKAGE_NAME = "@sagmans/pi-ptc";
const PACKAGE_VERSION = "0.1.0";
const REPOSITORY = "sagmans/pi-ptc";
const CONFIRMATION = "bootstrap-publish";
const REGISTRY_ARGUMENT = "--registry=https://registry.npmjs.org";
const FAKE_NPM_SOURCE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + "\n");
if (args[0] === "--version") process.stdout.write("11.15.0\n");
else if (args[0] === "whoami") process.stdout.write((process.env.FAKE_NPM_ACCOUNT || "sagmans") + "\n");
else if (args[0] === "view") { console.error("npm error code E404"); process.exit(1); }
else if (args[0] === "pack") {
  const destination = args[args.indexOf("--pack-destination") + 1];
  fs.mkdirSync(destination, { recursive: true });
  const tarball = path.join(destination, "sagmans-pi-ptc-0.1.0.tgz");
  fs.writeFileSync(tarball, "archive");
  process.stdout.write(path.basename(tarball) + "\n");
}
`;
const FAKE_GIT_SOURCE = `#!/usr/bin/env node
if (process.argv.slice(2).join(" ") === "status --porcelain --untracked-files=all") process.exit(0);
process.exit(1);
`;

type RunOptions = {
	readonly account?: string;
	readonly confirm?: string;
	readonly dryRun?: boolean;
};

function runBootstrap(options: RunOptions = {}) {
	const scratch = mkdtempSync(path.join(tmpdir(), "pi-ptc-bootstrap-test-"));
	try {
		const npmPath = path.join(scratch, "npm");
		const gitPath = path.join(scratch, "git");
		const callLog = path.join(scratch, "calls.jsonl");
		writeFileSync(npmPath, FAKE_NPM_SOURCE);
		writeFileSync(gitPath, FAKE_GIT_SOURCE);
		writeFileSync(callLog, "");
		chmodSync(npmPath, 0o755);
		chmodSync(gitPath, 0o755);
		const result = spawnSync("/bin/bash", [SCRIPT_PATH], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: {
				...process.env,
				CALL_LOG: callLog,
				CONFIRM: options.confirm ?? "",
				DRY_RUN: options.dryRun === true ? "1" : "0",
				FAKE_NPM_ACCOUNT: options.account ?? EXPECTED_ACCOUNT,
				GIT_BIN: gitPath,
				NODE_BIN: process.execPath,
				NPM_ACCOUNT: EXPECTED_ACCOUNT,
				NPM_BIN: npmPath,
				PKG_NAME: PACKAGE_NAME,
				PKG_VERSION: PACKAGE_VERSION,
				REPO: REPOSITORY,
			},
		});
		const calls = readFileSync(callLog, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as string[]);
		return { ...result, calls };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

test("bootstrap verifies account then publishes the exact smoked tarball", () => {
	const result = runBootstrap({ confirm: CONFIRMATION });
	assert.equal(result.status, 0, result.stderr);
	const smoke = result.calls.find((args) => args[0] === "run" && args[1] === "smoke");
	const dryRun = result.calls.find((args) => args[0] === "publish" && args.includes("--dry-run"));
	const publish = result.calls.find((args) => args[0] === "publish" && !args.includes("--dry-run"));
	assert.deepEqual(
		result.calls.find((args) => args[0] === "whoami"),
		["whoami", "--registry=https://registry.npmjs.org"],
	);
	assert.ok(smoke);
	assert.ok(dryRun);
	assert.ok(publish);
	assert.equal(smoke.at(-1), dryRun.at(1));
	assert.equal(dryRun.at(1), publish.at(1));
	assert.equal(dryRun.includes(REGISTRY_ARGUMENT), true);
	assert.equal(publish.includes(REGISTRY_ARGUMENT), true);
	assert.match(publish.at(1) ?? "", /sagmans-pi-ptc-0\.1\.0\.tgz$/u);
});

test("bootstrap rejects the wrong npm identity before package lookup", () => {
	const result = runBootstrap({ account: "other", confirm: CONFIRMATION });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /npm account must be sagmans/u);
	assert.equal(
		result.calls.some((args) => args[0] === "view"),
		false,
	);
	assert.equal(
		result.calls.some((args) => args[0] === "publish"),
		false,
	);
});

test("bootstrap requires exact confirmation before registry or artifact work", () => {
	const result = runBootstrap();
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /CONFIRM=bootstrap-publish/u);
	assert.equal(
		result.calls.some((args) => args[0] === "view"),
		false,
	);
	assert.equal(
		result.calls.some((args) => args[0] === "pack"),
		false,
	);
});

test("bootstrap dry-run verifies bytes without final publication", () => {
	const result = runBootstrap({ dryRun: true });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.calls.filter((args) => args[0] === "publish").length, 1);
	assert.equal(
		result.calls.some((args) => args[0] === "publish" && !args.includes("--dry-run")),
		false,
	);
	assert.match(result.stdout, /dry-run:.*npm.*publish/u);
});
