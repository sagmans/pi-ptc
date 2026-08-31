import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "../src/host.ts";
import { bootstrapPtcPackage } from "../src/package-bootstrap.ts";
import { SUPPORTED_PI_VERSION } from "../src/pi-runtime.ts";

const UNSUPPORTED_PI_VERSION = "0.84.2";
const NATIVE_TOOL_NAME = "read";
const PTC_TOOL_NAME = "ptc";
const PACKAGE_LOADER_TIMEOUT_MS = 30_000;
const PACKAGE_LOADER_SCRIPT = `
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const extensionPath = process.argv[1];
const directory = mkdtempSync(join(tmpdir(), "pi-ptc-package-loader-"));
const cwd = join(directory, "project");
const agentDir = join(directory, "agent");
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });
try {
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [extensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "",
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    tools: ["read", "ptc"],
  });
  await session.bindExtensions({ mode: "print" });
  console.log(JSON.stringify({
    active: session.getActiveToolNames(),
    all: session.getAllTools().map((tool) => tool.name),
    diagnostics: resourceLoader.getExtensions().diagnostics,
  }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
`;

type BootstrapHarness = {
	readonly pi: ExtensionAPI;
	readonly registered: string[];
	readonly active: string[];
};

function createBootstrapHarness(): BootstrapHarness {
	const registered: string[] = [];
	const active = [NATIVE_TOOL_NAME];
	return {
		registered,
		active,
		pi: {
			registerTool(definition) {
				registered.push(definition.name);
			},
			registerCommand() {},
			on() {},
			setActiveTools(names) {
				active.splice(0, active.length, ...names);
			},
			getActiveTools: () => [...active],
			getAllTools: () => active.map((name) => ({ name })),
			appendEntry() {},
			events: { emit() {} },
		},
	};
}

test("unsupported package bootstrap stays inert before implementation loading", async () => {
	const harness = createBootstrapHarness();
	let implementationLoads = 0;
	const installed = await bootstrapPtcPackage(harness.pi, {
		resolveVersion: () => UNSUPPORTED_PI_VERSION,
		loadInstaller: async () => {
			implementationLoads += 1;
			return () => {
				throw new Error("unsupported implementation must not run");
			};
		},
	});

	assert.equal(installed, false);
	assert.equal(implementationLoads, 0);
	assert.deepEqual(harness.registered, []);
	assert.deepEqual(harness.active, [NATIVE_TOOL_NAME]);
});

test("supported package bootstrap loads one complete installer", async () => {
	const harness = createBootstrapHarness();
	let implementationLoads = 0;
	const installed = await bootstrapPtcPackage(harness.pi, {
		resolveVersion: () => SUPPORTED_PI_VERSION,
		loadInstaller: async () => {
			implementationLoads += 1;
			return (pi) => pi.registerTool({ name: PTC_TOOL_NAME });
		},
	});

	assert.equal(installed, true);
	assert.equal(implementationLoads, 1);
	assert.deepEqual(harness.registered, [PTC_TOOL_NAME]);
	assert.deepEqual(harness.active, [NATIVE_TOOL_NAME]);
});

test("Pi package loader awaits bootstrap before binding the supported runtime", () => {
	const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
	const child = spawnSync(
		process.execPath,
		["--input-type=module", "--eval", PACKAGE_LOADER_SCRIPT, extensionPath],
		{ encoding: "utf8", timeout: PACKAGE_LOADER_TIMEOUT_MS },
	);
	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout.trim()) as {
		active: string[];
		all: string[];
		diagnostics: unknown[];
	};
	assert.deepEqual(result.active, [PTC_TOOL_NAME]);
	assert.equal(result.all.includes(NATIVE_TOOL_NAME), true);
	assert.equal(result.all.includes(PTC_TOOL_NAME), true);
	assert.deepEqual(result.diagnostics ?? [], []);
});

test("published root defers implementation and peers use the host bundle", () => {
	const rootSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	const packageJson = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	) as {
		peerDependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};

	assert.doesNotMatch(rootSource, /from ["']\.\/src\/index\.ts["']/);
	assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
	assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-tui"], "*");
	assert.equal(packageJson.peerDependencies?.typebox, "*");
	assert.equal(
		packageJson.devDependencies?.["@earendil-works/pi-coding-agent"],
		SUPPORTED_PI_VERSION,
	);
	assert.equal(packageJson.devDependencies?.["pi-mcp-adapter"], "2.29.0");
});
