import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	type ArtifactRuntime,
	DEFAULT_ARTIFACT_MIME_TYPE,
	type PtcArtifactRef,
} from "../src/artifacts.ts";
import { SHIPPED_PTC_CONFIG } from "../src/config.ts";
import { runCode } from "../src/runtime.ts";

const TEST_TIMEOUT_MS = 20_000;

type Directory = { cwd: string; artifacts: ArtifactRuntime; cleanup(): void };

function makeDirectory(): Directory {
	const root = mkdtempSync(join(tmpdir(), "pi-ptc-artifacts-"));
	const cwd = join(root, "project");
	const directory = join(root, "session.artifacts");
	mkdirSync(cwd);
	return {
		cwd,
		artifacts: { cwd, directory },
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

function failureMessage(value: unknown): string {
	return typeof value === "object" && value !== null && "message" in value
		? String((value as { message: unknown }).message)
		: "";
}

function isArtifactRef(value: unknown): value is PtcArtifactRef {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { kind?: unknown }).kind === "ptc-artifact"
	);
}

test("artifact captures a relative regular file from the session cwd", {
	timeout: TEST_TIMEOUT_MS,
}, async () => {
	const dir = makeDirectory();
	try {
		writeFileSync(join(dir.cwd, "data.bin"), "artifact bytes");
		const outcome = await runCode({
			program: 'return await artifact({ path: "data.bin" });',
			artifacts: dir.artifacts,
		});
		assert.equal(outcome.error, undefined);
		const ref = outcome.result;
		assert.ok(isArtifactRef(ref));
		assert.equal(ref.name, "data.bin");
		assert.equal(ref.mimeType, DEFAULT_ARTIFACT_MIME_TYPE);
		assert.equal(ref.bytes, "artifact bytes".length);
		assert.equal(readFileSync(ref.path, "utf8"), "artifact bytes");
	} finally {
		dir.cleanup();
	}
});

test("artifact survives deletion of its source", { timeout: TEST_TIMEOUT_MS }, async () => {
	const dir = makeDirectory();
	try {
		const source = join(dir.cwd, "report.html");
		writeFileSync(source, "<h1>Report</h1>");
		const outcome = await runCode({
			program:
				"return await artifact(" +
				JSON.stringify({ path: source, name: "report.html", mimeType: "text/html" }) +
				");",
			artifacts: dir.artifacts,
		});
		assert.ok(isArtifactRef(outcome.result));
		rmSync(source);
		assert.equal(readFileSync(outcome.result.path, "utf8"), "<h1>Report</h1>");
		assert.equal(outcome.result.name, "report.html");
		assert.equal(outcome.result.mimeType, "text/html");
	} finally {
		dir.cleanup();
	}
});

test("artifact rejects missing files, directories, and unsafe names", {
	timeout: TEST_TIMEOUT_MS,
}, async () => {
	const dir = makeDirectory();
	try {
		mkdirSync(join(dir.cwd, "nested"));
		const missing = await runCode({
			program: 'return await artifact({ path: "missing.txt" });',
			artifacts: dir.artifacts,
		});
		assert.match(failureMessage(missing.error), /existing regular file/);
		assert.match(failureMessage(missing.error), /missing.txt/);

		const directorySource = await runCode({
			program: 'return await artifact({ path: "nested" });',
			artifacts: dir.artifacts,
		});
		assert.match(failureMessage(directorySource.error), /existing regular file/);

		const unsafeName = await runCode({
			program: 'return await artifact({ path: "missing.txt", name: "../escape.txt" });',
			artifacts: dir.artifacts,
		});
		assert.match(failureMessage(unsafeName.error), /artifact name/);
		assert.equal(existsSync(dir.artifacts.directory), false);
	} finally {
		dir.cleanup();
	}
});

test("byte-oversized successful results spill to result.json", {
	timeout: TEST_TIMEOUT_MS,
}, async () => {
	const dir = makeDirectory();
	try {
		const value = "x".repeat(600);
		const outcome = await runCode({
			program: `return ${JSON.stringify(value)};`,
			artifacts: dir.artifacts,
			maxOutputBytes: 512,
			maxOutputLines: 10_000,
		});
		assert.ok(isArtifactRef(outcome.result), JSON.stringify(outcome));
		assert.equal(outcome.result.name, "result.json");
		assert.equal(outcome.result.mimeType, "application/json");
		assert.equal(JSON.parse(readFileSync(outcome.result.path, "utf8")), value);
	} finally {
		dir.cleanup();
	}
});

test("line-oversized successful results spill to result.json", {
	timeout: TEST_TIMEOUT_MS,
}, async () => {
	const dir = makeDirectory();
	try {
		const outcome = await runCode({
			program: 'return "one\\ntwo\\nthree\\nfour";',
			artifacts: dir.artifacts,
			maxOutputBytes: SHIPPED_PTC_CONFIG.maxOutputBytes,
			maxOutputLines: 2,
		});
		assert.ok(isArtifactRef(outcome.result));
		assert.equal(outcome.result.name, "result.json");
		assert.deepEqual(
			JSON.parse(readFileSync(outcome.result.path, "utf8")),
			"one\ntwo\nthree\nfour",
		);
	} finally {
		dir.cleanup();
	}
});

test("without artifact storage the output-limit failure is retained", {
	timeout: TEST_TIMEOUT_MS,
}, async () => {
	const outcome = await runCode({
		program: 'return "one\\ntwo\\nthree";',
		maxOutputBytes: 1024,
		maxOutputLines: 2,
	});
	assert.deepEqual(outcome, {
		logs: [],
		error: { kind: "output-limit", message: "program result exceeds maxOutputLines: 3 > 2" },
	});
});

test("oversized logs never spill and create no artifacts", {
	timeout: TEST_TIMEOUT_MS,
}, async () => {
	const dir = makeDirectory();
	try {
		const outcome = await runCode({
			program: 'console.log("one"); console.log("two"); console.log("three"); return 1;',
			artifacts: dir.artifacts,
			maxOutputBytes: SHIPPED_PTC_CONFIG.maxOutputBytes,
			maxOutputLines: 2,
		});
		assert.deepEqual(outcome, {
			logs: ["one", "two"],
			error: { kind: "output-limit", message: "log output exceeds maxOutputLines: 3 > 2" },
		});
		assert.equal(existsSync(dir.artifacts.directory), false);
	} finally {
		dir.cleanup();
	}
});

test("an artifact reference that cannot fit the limit keeps the output-limit failure", {
	timeout: TEST_TIMEOUT_MS,
}, async () => {
	const dir = makeDirectory();
	try {
		const outcome = await runCode({
			program: 'return "x".repeat(300);',
			artifacts: dir.artifacts,
			maxOutputBytes: 16,
			maxOutputLines: 10_000,
		});
		assert.equal(outcome.error?.kind, "output-limit");
		assert.match(failureMessage(outcome.error), /maxOutputBytes/);
	} finally {
		dir.cleanup();
	}
});
