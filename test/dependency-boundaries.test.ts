import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_ROOT = join(REPOSITORY_ROOT, "src");
const PI_RUNTIME_PREFIX = "pi-runtime-";
const PI_RUNTIME_FACADE = "pi-runtime.ts";
const PACKAGE_BOOTSTRAP = "package-bootstrap.ts";
const PI_RUNTIME_CONTRACT = "./pi-runtime-contract.ts";
const PTC_EXECUTION = "ptc-execution.ts";
const PTC_LIFECYCLE_IMPORT = "./ptc-lifecycle.ts";
const RENDERER_RAW_STORE = "renderer-raw-store.ts";
const WORKER_PROTOCOL = "worker-protocol.ts";
const PACKAGE_FILE = "package.json";
const ROOT_EXPORT = ".";
const IMPORT_PATTERN = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
const RAW_STORE_FORBIDDEN_PATTERN =
	/(?:call.?id|toolCallId|RendererToken|renderer-definition-store)/i;
const PROTOCOL_DECLARATION_PATTERN =
	/^(?:export\s+)?(?:type\s+(?:HostToWorker|WorkerToHost|WorkerBootData)\s*=|interface\s+(?:HostToWorker|WorkerToHost|WorkerBootData)\b)/m;
const PROTOCOL_CONSUMERS = new Set(["runtime.ts", "worker-session.ts", "worker.ts"]);

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
	return [...source(path).matchAll(IMPORT_PATTERN)].map((match) => match[1] ?? "");
}

function repositoryPath(path: string): string {
	return relative(REPOSITORY_ROOT, path).split(sep).join("/");
}

test("private Pi runtime modules stay behind the exact-version facade", () => {
	const violations: string[] = [];
	for (const caller of sourceFiles()) {
		if (caller === PI_RUNTIME_FACADE || caller.startsWith(PI_RUNTIME_PREFIX)) continue;
		for (const dependency of imports(caller)) {
			const target = basename(dependency);
			const bootstrapException = caller === PACKAGE_BOOTSTRAP && dependency === PI_RUNTIME_CONTRACT;
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

test("package publishes only the bootstrapped root", () => {
	const packageJson = JSON.parse(readFileSync(join(REPOSITORY_ROOT, PACKAGE_FILE), "utf8")) as {
		exports?: unknown;
	};
	assert.deepEqual(packageJson.exports, { [ROOT_EXPORT]: "./index.ts" });
	assert.equal(repositoryPath(join(REPOSITORY_ROOT, "index.ts")), "index.ts");
});
