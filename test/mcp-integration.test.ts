import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { TRANSPORT_NAME } from "../src/config.ts";
import type { ExtensionAPI } from "../src/host.ts";
import installPtc from "../src/index.ts";
import type { PtcPartialResult, PtcToolResult } from "../src/transport.ts";

const TEST_TIMEOUT_MS = 30_000;
const SERVER_REQUEST_TIMEOUT_MS = 5_000;
const CANCELLATION_DELAY_MS = 100;
const TOOL_REGISTRATION_TIMEOUT_MS = 2_000;
const TOOL_REGISTRATION_POLL_MS = 20;
const DIRECT_SERVER = "direct";
const PROXY_SERVER = "proxy";
const DIRECT_TOOL = "direct_echo";
const NAMESPACE_TOOL = "mcp__proxy";
const ALLOWED_TOOL_NAMES = Object.freeze([
	"read",
	TRANSPORT_NAME,
	"mcp",
	"mcpScript",
	"direct_echo",
	"direct_structured",
	"direct_fail",
	"direct_guarded",
	"direct_progress",
	"direct_reveal",
	"direct_late",
	"direct_slow",
	NAMESPACE_TOOL,
]);
const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/mcp-server.ts", import.meta.url));
const MCP_APPROVAL_EVENT = "pi-mcp-adapter:tool-approval-request";
const MCP_ADAPTER_PATH = fileURLToPath(import.meta.resolve("pi-mcp-adapter"));

type ToolDefinition = {
	name: string;
	renderCall?: unknown;
	renderResult?: unknown;
	execute(
		toolCallId: string,
		params: { code: string; description: string },
		signal?: AbortSignal,
		onUpdate?: (partial: PtcPartialResult) => void,
	): Promise<PtcToolResult>;
};

type ApprovalRequest = {
	originalToolName: string;
	origin: string;
	claim(handler: () => Promise<"deny">): boolean;
};

type Runtime = {
	directory: string;
	exitMarker: string;
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	notifications: string[];
	hookCalls: string[];
	approvalOrigins: string[];
};

function fixtureServer(directTools: boolean, exitMarker: string) {
	return {
		command: process.execPath,
		args: [FIXTURE_PATH],
		env: { PTC_MCP_EXIT_MARKER: exitMarker },
		directTools,
		requestTimeoutMs: SERVER_REQUEST_TIMEOUT_MS,
		approveTools: ["guarded"],
	};
}

async function createRuntime(): Promise<Runtime> {
	const directory = mkdtempSync(join(tmpdir(), "pi-ptc-mcp-"));
	const cwd = join(directory, "project");
	const agentDir = join(directory, "agent");
	const exitMarker = join(directory, "mcp-exit.log");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const notifications: string[] = [];
	const hookCalls: string[] = [];
	const approvalOrigins: string[] = [];
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_MCP_CONFIG_MODE = "exclusive";
	process.env.MCP_DIRECT_TOOLS = DIRECT_SERVER;
	writeFileSync(
		join(agentDir, "mcp.json"),
		JSON.stringify({
			settings: {
				hostConfigDiscovery: "off",
				directToolResultDetails: "bounded",
				toolResultRendering: "compact",
			},
			mcpServers: {
				[DIRECT_SERVER]: fixtureServer(true, exitMarker),
				[PROXY_SERVER]: fixtureServer(false, exitMarker),
			},
		}),
	);
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [MCP_ADAPTER_PATH],
		extensionFactories: [
			{
				name: "mcp-observer",
				factory(pi) {
					pi.on("tool_call", (event) => {
						hookCalls.push(`call:${event.toolName}`);
					});
					pi.on("tool_result", (event) => {
						hookCalls.push(`result:${event.toolName}:${String(event.isError)}`);
					});
					const events = pi.events as unknown as {
						on(name: string, handler: (request: ApprovalRequest) => void): void;
					};
					events.on(MCP_APPROVAL_EVENT, (request) => {
						if (request.originalToolName !== "guarded") return;
						approvalOrigins.push(request.origin);
						request.claim(async () => "deny");
					});
				},
			},
			{
				name: "pi-ptc",
				factory(pi) {
					installPtc(pi as unknown as ExtensionAPI, {
						resolvePaths: () => ({
							projectFile: join(cwd, ".pi", "ptc.json"),
							userFile: join(agentDir, "ptc.json"),
						}),
					});
				},
			},
		],
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
		tools: [...ALLOWED_TOOL_NAMES],
	});
	await session.bindExtensions({
		mode: "print",
		uiContext: {
			notify(message: string) {
				notifications.push(message);
			},
			setStatus() {},
		} as never,
	});
	return { directory, exitMarker, session, notifications, hookCalls, approvalOrigins };
}

function ptcTool(runtime: Runtime): ToolDefinition {
	const session = runtime.session as unknown as {
		_toolRegistry: Map<string, unknown>;
	};
	const definition = session._toolRegistry.get(TRANSPORT_NAME) as ToolDefinition | undefined;
	assert.ok(definition);
	return definition;
}

function outer(result: PtcToolResult): Record<string, unknown> {
	return JSON.parse(result.content[0]?.text ?? "") as Record<string, unknown>;
}

async function execute(
	runtime: Runtime,
	id: string,
	code: string,
	signal?: AbortSignal,
	onUpdate?: (partial: PtcPartialResult) => void,
): Promise<PtcToolResult> {
	return ptcTool(runtime).execute(id, { code, description: id }, signal, onUpdate);
}

async function waitForCondition(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + TOOL_REGISTRATION_TIMEOUT_MS;
	while (!condition()) {
		if (Date.now() >= deadline) return;
		await new Promise((resolve) => setTimeout(resolve, TOOL_REGISTRATION_POLL_MS));
	}
}

async function waitForTool(runtime: Runtime, name: string): Promise<void> {
	await waitForCondition(() => runtime.session.getAllTools().some((tool) => tool.name === name));
}

async function shutdown(runtime: Runtime): Promise<void> {
	const runner = runtime.session.extensionRunner as unknown as {
		emit(event: object): Promise<unknown>;
		invalidate(): void;
	};
	await runner.emit({ type: "session_shutdown", reason: "test" });
	runner.invalidate();
	runtime.session.dispose();
}

test("PTC reaches real proxy, script, direct, and namespace MCP tools", {
	timeout: TEST_TIMEOUT_MS,
}, async () => {
	const runtime = await createRuntime();
	const updates: PtcPartialResult[] = [];
	try {
		assert.deepEqual(runtime.session.getActiveToolNames(), [TRANSPORT_NAME]);
		const first = outer(
			await execute(
				runtime,
				"mcp-discovery",
				`
const status = await tools.mcp({});
await tools.mcp({ connect: "${DIRECT_SERVER}" });
await tools.mcp({ connect: "${PROXY_SERVER}" });
const search = await tools.mcp({ search: "structured", includeSchemas: true });
const describe = await tools.mcp({ describe: "direct_echo" });
const called = await tools.mcp({ tool: "direct_echo", args: { text: "proxy-ok" } });
const progress = await tools.mcp({ tool: "proxy_progress", args: {} });
const lateBefore = typeof tools.direct_late;
const reveal = await tools.mcp({ tool: "direct_reveal", args: {} });
const lateAfter = typeof tools.direct_late;
const scripted = await tools.mcpScript({ code: 'return await tools.call("proxy_structured", { value: 4 })' });
const denied = await tools.mcp({ tool: "proxy_guarded", args: {} });
let failed = "not-failed";
try { await tools.mcp({ tool: "proxy_fail", args: {} }); } catch (error) { failed = String(error); }
return { status, search, describe, called, progress, reveal, lateBefore, lateAfter, scripted, denied, failed };
`,
				undefined,
				(partial) => updates.push(partial),
			),
		);
		assert.deepEqual(runtime.session.getActiveToolNames(), [TRANSPORT_NAME]);
		assert.match(JSON.stringify(first.result), /proxy-ok/);
		assert.match(JSON.stringify(first.result), /structured:4/);
		assert.match(JSON.stringify(first.result), /approval_denied/);
		assert.match(JSON.stringify(first.result), /fixture failure/);
		assert.match(JSON.stringify(first.result), /"lateBefore":"undefined"/);
		assert.match(JSON.stringify(first.result), /"lateAfter":"undefined"/);
		assert.equal(updates.length > 0, true);
		assert.equal(
			runtime.approvalOrigins.includes("proxy"),
			true,
			JSON.stringify({ first, origins: runtime.approvalOrigins }),
		);

		assert.equal(
			runtime.session.getAllTools().some((tool) => tool.name === DIRECT_TOOL),
			true,
			JSON.stringify(runtime.session.getAllTools().map((tool) => tool.name)),
		);
		await waitForTool(runtime, "direct_late");
		const second = outer(
			await execute(
				runtime,
				"mcp-next-snapshot",
				`
const direct = await tools.${DIRECT_TOOL}({ text: "direct-ok" });
const late = await tools.direct_late({});
const namespaced = await tools.${NAMESPACE_TOOL}({ tool: "proxy_structured", args: { value: 7 } });
return { direct, late, namespaced };
`,
			),
		);
		assert.match(JSON.stringify(second.result), /direct-ok/);
		assert.match(JSON.stringify(second.result), /structured:7/);
		assert.match(JSON.stringify(second.result), /late-ok/);
		const allNames = runtime.session.getAllTools().map((tool) => tool.name);
		assert.equal(allNames.includes(DIRECT_TOOL), true, JSON.stringify(allNames));
		assert.equal(allNames.includes(NAMESPACE_TOOL), true, JSON.stringify(allNames));
		const directDefinition = runtime.session.getToolDefinition(
			DIRECT_TOOL,
		) as unknown as ToolDefinition;
		assert.equal(typeof directDefinition.renderCall, "function");
		assert.equal(typeof directDefinition.renderResult, "function");
		assert.equal(
			runtime.hookCalls.some((entry) => entry === `call:${DIRECT_TOOL}`),
			true,
		);
		assert.equal(
			runtime.hookCalls.some((entry) => entry.startsWith(`result:${DIRECT_TOOL}:false`)),
			true,
		);
	} finally {
		await shutdown(runtime);
		assert.equal(existsSync(runtime.exitMarker), true);
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_MCP_CONFIG_MODE;
		delete process.env.MCP_DIRECT_TOOLS;
		rmSync(runtime.directory, { recursive: true, force: true });
	}
});

test("PTC cancellation aborts a real MCP request and preserves shutdown", {
	timeout: TEST_TIMEOUT_MS,
}, async () => {
	const runtime = await createRuntime();
	try {
		await execute(
			runtime,
			"mcp-connect",
			`await tools.mcp({ connect: "${PROXY_SERVER}" }); return true;`,
		);
		const controller = new AbortController();
		const pending = execute(
			runtime,
			"mcp-cancel",
			`return await tools.mcp({ tool: "proxy_slow", args: { delayMs: 10000 } });`,
			controller.signal,
		);
		setTimeout(() => controller.abort(new Error("fixture cancellation")), CANCELLATION_DELAY_MS);
		await assert.rejects(pending, /abort|cancel|fixture cancellation/i);
	} finally {
		await shutdown(runtime);
		assert.equal(existsSync(runtime.exitMarker), true);
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_MCP_CONFIG_MODE;
		delete process.env.MCP_DIRECT_TOOLS;
		rmSync(runtime.directory, { recursive: true, force: true });
	}
});
