import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LEAK_BLOCK_REASON, loadPresentation, TRANSPORT_NAME } from "../src/config.ts";
import type { PtcDispatchDetails } from "../src/dispatch-details.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/host.ts";
import installPtc from "../src/index.ts";
import type { PtcParams, PtcPartialResult, PtcToolResult } from "../src/transport.ts";

const FAILURE_TOOL_CALL_ID = "ptc-failure";
const SHUTDOWN_TOOL_CALL_ID = "ptc-shutdown";
const MISSING_TOOL_CALL_ID = "ptc-missing";
const SHARED_TOOL_CALL_ID = "ptc-shared";
const FAILURE_DESCRIPTION = "fail after nested dispatch";
const FIRST_FAILURE_DESCRIPTION = "first installer failure";
const SECOND_FAILURE_DESCRIPTION = "second installer failure";
const OUTER_FAILURE_MESSAGE = "planned outer failure";
const FIRST_OUTER_FAILURE_MESSAGE = "first planned failure";
const SECOND_OUTER_FAILURE_MESSAGE = "second planned failure";
const FAILURE_PROGRAM = `await tools.ls({ path: "." }); throw new Error("${OUTER_FAILURE_MESSAGE}");`;
const FIRST_FAILURE_PROGRAM = `throw new Error("${FIRST_OUTER_FAILURE_MESSAGE}");`;
const SECOND_FAILURE_PROGRAM = `throw new Error("${SECOND_OUTER_FAILURE_MESSAGE}");`;

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;
type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type RegisteredTool = {
	name: string;
	execute(
		toolCallId: string,
		params: PtcParams,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: PtcPartialResult) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<PtcToolResult>;
};

function createFakePi(
	active: string[],
	available: string[] = active,
): {
	pi: ExtensionAPI;
	tools: Map<string, RegisteredTool>;
	commands: Map<string, { handler: CommandHandler }>;
	handlers: Map<string, EventHandler>;
	notifications: string[];
	statuses: string[];
	ctx: ExtensionContext;
} {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, { handler: CommandHandler }>();
	const handlers = new Map<string, EventHandler>();
	const notifications: string[] = [];
	const statuses: string[] = [];
	let current = [...active];
	const registered = [...available];
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
			const tool = definition as RegisteredTool;
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

test("session_start preserves an intentionally empty active set", () => {
	const { pi, handlers, ctx } = createFakePi([], ["read", "bash", "mcp"]);
	installPtc(pi, { resolvePaths: tempPaths });
	handlers.get("session_start")?.({}, ctx);
	assert.deepEqual(pi.getActiveTools(), ["ptc"]);
});

test("turn_start preserves live foreign tool activation and removal", () => {
	const { pi, handlers, ctx } = createFakePi(["read", "bash", "mcp"]);
	installPtc(pi, { resolvePaths: tempPaths });
	handlers.get("session_start")?.({}, ctx);

	pi.setActiveTools([...pi.getActiveTools(), "web_search"]);
	handlers.get("turn_start")?.({}, ctx);
	assert.deepEqual(pi.getActiveTools(), ["mcp", "web_search", "ptc"]);

	pi.setActiveTools(["web_search", "ptc"]);
	handlers.get("turn_start")?.({}, ctx);
	assert.deepEqual(pi.getActiveTools(), ["web_search", "ptc"]);
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

test("failed ptc details are patched once by call id and cleared on shutdown", async () => {
	const { pi, tools, handlers, ctx } = createFakePi(["read", "bash", "ls"]);
	installPtc(pi, { resolvePaths: tempPaths });
	const tool = tools.get(TRANSPORT_NAME);
	assert.ok(tool);

	const executeFailure = (toolCallId: string) =>
		assert.rejects(
			tool.execute(
				toolCallId,
				{ code: FAILURE_PROGRAM, description: FAILURE_DESCRIPTION },
				undefined,
				undefined,
				ctx,
			),
			new RegExp(OUTER_FAILURE_MESSAGE),
		);
	await executeFailure(FAILURE_TOOL_CALL_ID);

	const toolResult = handlers.get("tool_result");
	assert.ok(toolResult);
	assert.equal(
		toolResult({ toolName: TRANSPORT_NAME, toolCallId: MISSING_TOOL_CALL_ID }, ctx),
		undefined,
	);
	const patch = toolResult({ toolName: TRANSPORT_NAME, toolCallId: FAILURE_TOOL_CALL_ID }, ctx) as {
		details: PtcDispatchDetails;
	};
	assert.equal(Object.hasOwn(patch, "content"), false);
	assert.equal(patch.details.schemaVersion, 2);
	assert.equal(patch.details.mode, "snapshot");
	assert.equal(patch.details.dispatches.length, 1);
	assert.equal(patch.details.dispatches[0]?.status, "ok");
	assert.match(patch.details.executionError ?? "", new RegExp(OUTER_FAILURE_MESSAGE));
	assert.equal(JSON.stringify(patch.details).includes(FAILURE_PROGRAM), false);
	assert.equal(
		toolResult({ toolName: TRANSPORT_NAME, toolCallId: FAILURE_TOOL_CALL_ID }, ctx),
		undefined,
	);

	await executeFailure(SHUTDOWN_TOOL_CALL_ID);
	handlers.get("session_shutdown")?.({}, ctx);
	assert.equal(
		toolResult({ toolName: TRANSPORT_NAME, toolCallId: SHUTDOWN_TOOL_CALL_ID }, ctx),
		undefined,
	);
});

test("failure handoff is isolated between installers with the same call id", async () => {
	const first = createFakePi(["read", "bash", "ls"]);
	const second = createFakePi(["read", "bash", "ls"]);
	installPtc(first.pi, { resolvePaths: tempPaths });
	installPtc(second.pi, { resolvePaths: tempPaths });
	const firstTool = first.tools.get(TRANSPORT_NAME);
	const secondTool = second.tools.get(TRANSPORT_NAME);
	const firstToolResult = first.handlers.get("tool_result");
	const secondToolResult = second.handlers.get("tool_result");
	assert.ok(firstTool);
	assert.ok(secondTool);
	assert.ok(firstToolResult);
	assert.ok(secondToolResult);

	await assert.rejects(
		firstTool.execute(
			SHARED_TOOL_CALL_ID,
			{ code: FIRST_FAILURE_PROGRAM, description: FIRST_FAILURE_DESCRIPTION },
			undefined,
			undefined,
			first.ctx,
		),
		new RegExp(FIRST_OUTER_FAILURE_MESSAGE),
	);
	await assert.rejects(
		secondTool.execute(
			SHARED_TOOL_CALL_ID,
			{ code: SECOND_FAILURE_PROGRAM, description: SECOND_FAILURE_DESCRIPTION },
			undefined,
			undefined,
			second.ctx,
		),
		new RegExp(SECOND_OUTER_FAILURE_MESSAGE),
	);

	const firstPatch = firstToolResult(
		{ toolName: TRANSPORT_NAME, toolCallId: SHARED_TOOL_CALL_ID },
		first.ctx,
	) as { details: PtcDispatchDetails };
	assert.match(firstPatch.details.executionError ?? "", new RegExp(FIRST_OUTER_FAILURE_MESSAGE));
	assert.equal(
		firstToolResult({ toolName: TRANSPORT_NAME, toolCallId: SHARED_TOOL_CALL_ID }, first.ctx),
		undefined,
	);
	const secondPatch = secondToolResult(
		{ toolName: TRANSPORT_NAME, toolCallId: SHARED_TOOL_CALL_ID },
		second.ctx,
	) as { details: PtcDispatchDetails };
	assert.match(secondPatch.details.executionError ?? "", new RegExp(SECOND_OUTER_FAILURE_MESSAGE));
	assert.equal(
		secondToolResult({ toolName: TRANSPORT_NAME, toolCallId: SHARED_TOOL_CALL_ID }, second.ctx),
		undefined,
	);

	await assert.rejects(
		firstTool.execute(
			SHARED_TOOL_CALL_ID,
			{ code: FIRST_FAILURE_PROGRAM, description: FIRST_FAILURE_DESCRIPTION },
			undefined,
			undefined,
			first.ctx,
		),
		new RegExp(FIRST_OUTER_FAILURE_MESSAGE),
	);
	await assert.rejects(
		secondTool.execute(
			SHARED_TOOL_CALL_ID,
			{ code: SECOND_FAILURE_PROGRAM, description: SECOND_FAILURE_DESCRIPTION },
			undefined,
			undefined,
			second.ctx,
		),
		new RegExp(SECOND_OUTER_FAILURE_MESSAGE),
	);
	first.handlers.get("session_shutdown")?.({}, first.ctx);
	assert.equal(
		firstToolResult({ toolName: TRANSPORT_NAME, toolCallId: SHARED_TOOL_CALL_ID }, first.ctx),
		undefined,
	);
	const survivingPatch = secondToolResult(
		{ toolName: TRANSPORT_NAME, toolCallId: SHARED_TOOL_CALL_ID },
		second.ctx,
	) as { details: PtcDispatchDetails };
	assert.match(
		survivingPatch.details.executionError ?? "",
		new RegExp(SECOND_OUTER_FAILURE_MESSAGE),
	);
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
