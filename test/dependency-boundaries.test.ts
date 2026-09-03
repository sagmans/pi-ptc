import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { SessionAssociation } from "../src/pi-runtime-association.ts";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_ROOT = join(REPOSITORY_ROOT, "src");
const PI_RUNTIME_PREFIX = "pi-runtime-";
const PI_RUNTIME_FACADE = "pi-runtime.ts";
const PACKAGE_BOOTSTRAP = "package-bootstrap.ts";
const PI_RUNTIME_VERSION = "./pi-runtime-version.ts";
const PI_RUNTIME_ASSOCIATION = "pi-runtime-association.ts";
const PTC_EXECUTION = "ptc-execution.ts";
const PTC_LIFECYCLE_IMPORT = "./ptc-lifecycle.ts";
const RENDERER_RAW_STORE = "renderer-raw-store.ts";
const WORKER_PROTOCOL = "worker-protocol.ts";
const PACKAGE_FILE = "package.json";
const ROOT_EXPORT = ".";
const ASSOCIATION_FIELD_NAMES = [
	"parts",
	"toolGeneration",
	"runtimeActionsInstalled",
	"runtimeEventFinalizersInstalled",
	"definition",
	"installer",
] as const;
const ASSOCIATION_STATE_ACCESS_PATTERN = new RegExp(
	`association\\.(?:${ASSOCIATION_FIELD_NAMES.join("|")})\\b`,
);
type LeakedAssociationField = Extract<
	keyof SessionAssociation,
	(typeof ASSOCIATION_FIELD_NAMES)[number]
>;
const ASSOCIATION_FIELDS_ARE_OPAQUE: [LeakedAssociationField] extends [never] ? true : false = true;
const STATIC_IMPORT_PATTERN = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const RAW_STORE_FORBIDDEN_PATTERN =
	/(?:call.?id|toolCallId|RendererToken|renderer-definition-store)/i;
const PROTOCOL_DECLARATION_PATTERN =
	/^(?:export\s+)?(?:type\s+(?:HostToWorker|WorkerToHost|WorkerBootData)\s*=|interface\s+(?:HostToWorker|WorkerToHost|WorkerBootData)\b)/m;
const PROTOCOL_CONSUMERS = new Set([
	"worker-bindings.ts",
	"worker-failure.ts",
	"worker-result.ts",
	"worker-session.ts",
	"worker.ts",
]);

function sourceFiles(): string[] {
	return readdirSync(SOURCE_ROOT, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => entry.name)
		.sort();
}

function source(path: string): string {
	return readFileSync(join(SOURCE_ROOT, path), "utf8");
}

function imports(path: string): string[] {
	const contents = source(path);
	return [STATIC_IMPORT_PATTERN, DYNAMIC_IMPORT_PATTERN].flatMap((pattern) =>
		[...contents.matchAll(pattern)].map((match) => match[1] ?? ""),
	);
}

function repositoryPath(path: string): string {
	return relative(REPOSITORY_ROOT, path).split(sep).join("/");
}

function localDependencies(path: string): string[] {
	return imports(path)
		.filter((dependency) => dependency.startsWith("./") && dependency.endsWith(".ts"))
		.map((dependency) => basename(dependency));
}

function importCycles(): string[] {
	const cycles = new Set<string>();
	const visiting: string[] = [];
	const visited = new Set<string>();
	const visit = (path: string): void => {
		const activeIndex = visiting.indexOf(path);
		if (activeIndex >= 0) {
			const cycle = [...visiting.slice(activeIndex), path];
			const rotations = cycle
				.slice(0, -1)
				.map((_, index, nodes) => [...nodes.slice(index), ...nodes.slice(0, index)]);
			cycles.add(rotations.map((nodes) => nodes.join(" -> ")).sort()[0] ?? cycle.join(" -> "));
			return;
		}
		if (visited.has(path)) return;
		visiting.push(path);
		for (const dependency of localDependencies(path)) visit(dependency);
		visiting.pop();
		visited.add(path);
	};
	for (const path of sourceFiles()) visit(path);
	return [...cycles].sort();
}

test("private Pi runtime modules stay behind the verified-version facade", () => {
	const violations: string[] = [];
	for (const caller of sourceFiles()) {
		if (caller === PI_RUNTIME_FACADE || caller.startsWith(PI_RUNTIME_PREFIX)) continue;
		for (const dependency of imports(caller)) {
			const target = basename(dependency);
			const bootstrapException = caller === PACKAGE_BOOTSTRAP && dependency === PI_RUNTIME_VERSION;
			if (target.startsWith(PI_RUNTIME_PREFIX) && !bootstrapException) {
				violations.push(`${caller} imports ${dependency}`);
			}
		}
	}
	assert.deepEqual(violations, []);
});

test("Pi shape, action, and event dependencies remain acyclic", () => {
	assert.equal(imports("pi-runtime-shape.ts").includes("./pi-runtime-association.ts"), false);
	for (const caller of ["pi-runtime-actions.ts", "pi-runtime-events.ts"]) {
		assert.equal(imports(caller).includes("./pi-runtime-session.ts"), false, caller);
	}
});

test("session association state stays opaque outside its owner", () => {
	const violations = sourceFiles()
		.filter((path) => path.startsWith(PI_RUNTIME_PREFIX) && path !== PI_RUNTIME_ASSOCIATION)
		.filter((path) => ASSOCIATION_STATE_ACCESS_PATTERN.test(source(path)));
	assert.equal(ASSOCIATION_FIELDS_ARE_OPAQUE, true);
	assert.doesNotMatch(source("pi-runtime-registry.ts"), /export type SessionAssociation\b/);
	assert.deepEqual(violations, []);
});

test("execution consumes immutable leases without lifecycle reach-through", () => {
	assert.equal(imports(PTC_EXECUTION).includes(PTC_LIFECYCLE_IMPORT), false);
});

test("raw renderer attachments expose no call-ID recovery path", () => {
	assert.doesNotMatch(source(RENDERER_RAW_STORE), RAW_STORE_FORBIDDEN_PATTERN);
});

test("host and worker share one protocol owner", () => {
	const protocolConsumers = sourceFiles()
		.filter((path) => imports(path).includes(`./${WORKER_PROTOCOL}`))
		.sort();
	assert.deepEqual(protocolConsumers, [...PROTOCOL_CONSUMERS].sort());
	for (const path of sourceFiles()) {
		if (path === WORKER_PROTOCOL) continue;
		assert.doesNotMatch(source(path), PROTOCOL_DECLARATION_PATTERN, path);
	}
});

test("source import graph remains acyclic", () => {
	assert.deepEqual(importCycles(), []);
});

test("package publishes only the bootstrapped root", () => {
	const packageJson = JSON.parse(readFileSync(join(REPOSITORY_ROOT, PACKAGE_FILE), "utf8")) as {
		exports?: unknown;
	};
	assert.deepEqual(packageJson.exports, { [ROOT_EXPORT]: "./index.ts" });
	assert.equal(repositoryPath(join(REPOSITORY_ROOT, "index.ts")), "index.ts");
});
