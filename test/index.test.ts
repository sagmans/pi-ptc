import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LEAK_BLOCK_REASON, loadPresentation, TRANSPORT_NAME } from "../src/config.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/host.ts";
import installPtc from "../src/index.ts";

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;
type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function createFakePi(active: string[]): {
	pi: ExtensionAPI;
	tools: Map<string, { name: string }>;
	commands: Map<string, { handler: CommandHandler }>;
	handlers: Map<string, EventHandler>;
	notifications: string[];
	statuses: string[];
	ctx: ExtensionContext;
} {
	const tools = new Map<string, { name: string }>();
	const commands = new Map<string, { handler: CommandHandler }>();
	const handlers = new Map<string, EventHandler>();
	const notifications: string[] = [];
	const statuses: string[] = [];
	let current = [...active];
	const registered = [...active];
	const ctx: ExtensionContext = {
		cwd: "/tmp",
		ui: {
			notify(message) {
				notifications.push(message);
			},
			setStatus(_key, text) {
				if (text) statuses.push(text);
			},
		},
		isProjectTrusted: () => true,
	};
	const pi: ExtensionAPI = {
		registerTool(definition) {
			const tool = definition as { name: string };
			tools.set(tool.name, tool);
			if (!registered.includes(tool.name)) registered.push(tool.name);
		},
		registerCommand(name, definition) {
			commands.set(name, definition as { handler: CommandHandler });
		},
		on(event, handler) {
			handlers.set(event, handler as EventHandler);
		},
		setActiveTools(names) {
			current = [...names];
		},
		getActiveTools() {
			return [...current];
		},
		getAllTools() {
			return registered.map((name) => ({ name }));
		},
		appendEntry() {},
		events: { emit() {} },
	};
	return { pi, tools, commands, handlers, notifications, statuses, ctx };
}

function tempPaths() {
	const dir = mkdtempSync(join(tmpdir(), "pi-ptc-index-"));
	return {
		projectFile: join(dir, "project", "ptc.json"),
		userFile: join(dir, "user", "ptc.json"),
	};
}

test("installer is a function Pi can load", () => {
	const { pi } = createFakePi(["read", "bash", "mcp"]);
	assert.equal(typeof installPtc, "function");
	installPtc(pi, { resolvePaths: tempPaths });
	assert.equal(
		pi.getAllTools().some((tool) => tool.name === TRANSPORT_NAME),
		true,
	);
});

test("session_start hides core tools and keeps foreign tools", () => {
	const { pi, handlers, ctx, statuses } = createFakePi([
		"read",
		"bash",
		"edit",
		"write",
		"grep",
		"find",
		"ls",
		"mcp",
		"mcpScript",
	]);
	installPtc(pi, { resolvePaths: tempPaths });
	handlers.get("session_start")?.({}, ctx);
	assert.deepEqual(pi.getActiveTools(), ["mcp", "mcpScript", "ptc"]);
	assert.deepEqual(statuses, ["ptc: code"]);
});

test("competing owner stays inert", () => {
	const { pi, handlers, ctx, notifications } = createFakePi(["read", "bash", "fabric_exec"]);
	installPtc(pi, { resolvePaths: tempPaths });
	handlers.get("session_start")?.({}, ctx);
	assert.deepEqual(pi.getActiveTools(), ["read", "bash", "fabric_exec"]);
	assert.match(notifications[0] ?? "", /inert/);
});

test("tool_call blocks leaked core tools under code presentation", () => {
	const { pi, handlers, ctx } = createFakePi(["read", "bash", "mcp"]);
	installPtc(pi, { resolvePaths: tempPaths });
	handlers.get("session_start")?.({}, ctx);
	const blocked = handlers.get("tool_call")?.({ toolName: "read" }, ctx);
	assert.deepEqual(blocked, { block: true, reason: LEAK_BLOCK_REASON });
	assert.equal(handlers.get("tool_call")?.({ toolName: "mcp" }, ctx), undefined);
});

test("/ptc off restores native core tools and persists", async () => {
	const paths = tempPaths();
	const { pi, handlers, commands, ctx } = createFakePi(["read", "bash", "mcp"]);
	installPtc(pi, { resolvePaths: () => paths });
	handlers.get("session_start")?.({}, ctx);
	await commands.get("ptc")?.handler("off", ctx);
	assert.deepEqual(pi.getActiveTools(), ["read", "bash", "mcp"]);
	assert.equal(loadPresentation({ projectFile: paths.projectFile, fallback: "code" }), "native");
});

test("before_agent_start injects the sdk and restores skills when read is hidden", () => {
	const { pi, handlers, ctx } = createFakePi(["read", "bash", "mcp"]);
	installPtc(pi, { resolvePaths: tempPaths });
	handlers.get("session_start")?.({}, ctx);
	const result = handlers.get("before_agent_start")?.(
		{
			systemPrompt: "base",
			systemPromptOptions: {
				skills: [
					{
						name: "demo",
						description: "demo skill",
						filePath: "/tmp/demo/SKILL.md",
						disableModelInvocation: false,
					},
				],
			},
		},
		ctx,
	) as { systemPrompt: string };
	assert.match(result.systemPrompt, /await tools\.read\(/);
	assert.match(result.systemPrompt, /tools\.read/);
	assert.match(result.systemPrompt, /<name>demo<\/name>/);
});
