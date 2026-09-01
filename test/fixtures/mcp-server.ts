import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "pi-ptc-mcp-fixture";
const SERVER_VERSION = "1.0.0";
const DEFAULT_DELAY_MS = 10_000;
const EXIT_MARKER = process.env.PTC_MCP_EXIT_MARKER;

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
};

const pending = new Map<string | number, ReturnType<typeof setTimeout>>();

function send(value: object): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function result(id: string | number, value: object): void {
	send({ jsonrpc: "2.0", id, result: value });
}

function error(id: string | number, code: number, message: string): void {
	send({ jsonrpc: "2.0", id, error: { code, message } });
}

function tool(name: string, description: string, properties: Record<string, object> = {}) {
	return {
		name,
		description,
		inputSchema: { type: "object", properties, additionalProperties: false },
	};
}

let lateToolVisible = false;
const lateTool = tool("late", "Tool revealed during a session");
const tools = [
	tool("echo", "Echo text", { text: { type: "string" } }),
	tool("structured", "Return structured content", { value: { type: "number" } }),
	tool("fail", "Return an MCP tool error"),
	tool("guarded", "Approval-gated fixture tool"),
	tool("progress", "Publish progress before completion"),
	tool("reveal", "Reveal a late direct tool"),
	tool("slow", "Wait until cancelled", { delayMs: { type: "number" } }),
];

function callTool(id: string | number, params: Record<string, unknown>): void {
	const name = params.name;
	const args = (params.arguments ?? {}) as Record<string, unknown>;
	const meta = (params._meta ?? {}) as Record<string, unknown>;
	if (name === "echo") {
		result(id, { content: [{ type: "text", text: String(args.text ?? "") }] });
		return;
	}
	if (name === "structured") {
		const value = Number(args.value ?? 0);
		result(id, {
			content: [{ type: "text", text: `structured:${value}` }],
			structuredContent: { value, doubled: value * 2 },
		});
		return;
	}
	if (name === "fail") {
		result(id, { isError: true, content: [{ type: "text", text: "fixture failure" }] });
		return;
	}
	if (name === "guarded") {
		result(id, { content: [{ type: "text", text: "guarded executed" }] });
		return;
	}
	if (name === "progress") {
		const progressToken = meta.progressToken;
		if (typeof progressToken === "string" || typeof progressToken === "number") {
			send({
				jsonrpc: "2.0",
				method: "notifications/progress",
				params: { progressToken, progress: 1, total: 1, message: "fixture progress" },
			});
		}
		result(id, { content: [{ type: "text", text: "progress complete" }] });
		return;
	}
	if (name === "reveal") {
		lateToolVisible = true;
		send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		result(id, { content: [{ type: "text", text: "late tool revealed" }] });
		return;
	}
	if (name === "late") {
		result(id, { content: [{ type: "text", text: "late-ok" }] });
		return;
	}
	if (name === "slow") {
		const delayMs = Number(args.delayMs ?? DEFAULT_DELAY_MS);
		pending.set(
			id,
			setTimeout(() => {
				pending.delete(id);
				result(id, { content: [{ type: "text", text: "slow complete" }] });
			}, delayMs),
		);
		return;
	}
	error(id, -32602, `Unknown tool: ${String(name)}`);
}

function handle(request: JsonRpcRequest): void {
	if (request.method === "notifications/cancelled") {
		const requestId = request.params?.requestId;
		if (typeof requestId === "string" || typeof requestId === "number") {
			const timer = pending.get(requestId);
			if (timer) clearTimeout(timer);
			pending.delete(requestId);
		}
		return;
	}
	if (request.id === undefined) return;
	if (request.method === "initialize") {
		result(request.id, {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: { tools: { listChanged: true } },
			serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
			instructions: "Deterministic local pi-ptc integration fixture.",
		});
		return;
	}
	if (request.method === "ping") {
		result(request.id, {});
		return;
	}
	if (request.method === "tools/list") {
		result(request.id, { tools: lateToolVisible ? [...tools, lateTool] : tools });
		return;
	}
	if (request.method === "tools/call") {
		callTool(request.id, request.params ?? {});
		return;
	}
	error(request.id, -32601, `Method not found: ${request.method}`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
lines.on("line", (line) => {
	try {
		handle(JSON.parse(line) as JsonRpcRequest);
	} catch (caught) {
		process.stderr.write(`${caught instanceof Error ? caught.message : String(caught)}\n`);
	}
});

process.on("exit", () => {
	if (EXIT_MARKER) appendFileSync(EXIT_MARKER, `${process.pid}\n`);
});
