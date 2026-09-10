// Strict LF-only JSONL RPC client for Pi. Node readline is not
// protocol-compliant because it also splits on U+2028/U+2029.

import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 600_000;

export type PiRpcEvent = {
	type?: string;
	id?: string;
	success?: boolean;
	error?: string;
	data?: unknown;
	usage?: { cost?: { total?: number } };
} & Record<string, unknown>;

type PiRpcCommand = Record<string, unknown>;

type PiRpcOptions = {
	piBinary?: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	responseTimeoutMs?: number;
	settleTimeoutMs?: number;
};

type PiRpcWaiter = {
	predicate: (record: PiRpcEvent) => boolean;
	reject: (error: Error) => void;
	tryResolve: (events: PiRpcEvent[]) => boolean;
};

export class PiRpcClient {
	readonly process: ChildProcess;
	readonly stderr: string[] = [];
	readonly events: PiRpcEvent[] = [];
	private nextRequestId = 1;
	private lineBuffer = "";
	private readonly decoder = new StringDecoder("utf8");
	private waiters: PiRpcWaiter[] = [];
	private closed = false;
	private readonly responseTimeoutMs: number;
	private readonly settleTimeoutMs: number;

	constructor(childProcess: ChildProcess, options: PiRpcOptions = {}) {
		this.process = childProcess;
		this.responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
		this.settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
		childProcess.stdout?.on("data", (chunk) => this.onStdoutChunk(chunk));
		childProcess.stderr?.on("data", (chunk) => {
			this.stderr.push(String(chunk));
		});
		childProcess.on("exit", () => {
			this.closed = true;
			this.flushWaiters(new Error("pi rpc process exited"));
		});
	}

	static spawn(args: string[], options: PiRpcOptions = {}): PiRpcClient {
		const childProcess = spawn(options.piBinary ?? "pi", ["--mode", "rpc", ...args], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		return new PiRpcClient(childProcess, options);
	}

	private onStdoutChunk(chunk: string | Buffer): void {
		this.lineBuffer += this.decoder.write(chunk);
		while (true) {
			const newlineIndex = this.lineBuffer.indexOf("\n");
			if (newlineIndex === -1) break;
			let line = this.lineBuffer.slice(0, newlineIndex);
			this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.length === 0) continue;
			let record: PiRpcEvent;
			try {
				record = JSON.parse(line) as PiRpcEvent;
			} catch {
				continue;
			}
			this.events.push(record);
			this.flushWaiters();
		}
	}

	private flushWaiters(failure?: Error): void {
		if (failure) {
			for (const waiter of this.waiters.splice(0)) waiter.reject(failure);
			return;
		}
		this.waiters = this.waiters.filter((waiter) => !waiter.tryResolve(this.events));
	}

	send(command: PiRpcCommand): string {
		const id = `eval-${this.nextRequestId}`;
		this.nextRequestId += 1;
		this.process.stdin?.write(`${JSON.stringify({ ...command, id })}\n`);
		return id;
	}

	async request<T = unknown>(command: PiRpcCommand): Promise<T> {
		const id = this.send(command);
		const response = await this.waitFor((record) => record.type === "response" && record.id === id);
		if (response.success !== true) {
			throw new Error(`rpc command failed (${command.type}): ${response.error}`);
		}
		return response.data as T;
	}

	waitFor(
		predicate: (record: PiRpcEvent) => boolean,
		timeoutMs = this.responseTimeoutMs,
	): Promise<PiRpcEvent> {
		const existing = this.events.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const waiter = {
				predicate,
				reject,
				tryResolve: (events: PiRpcEvent[]) => {
					const match = events.find(predicate);
					if (!match) return false;
					resolve(match);
					return true;
				},
			};
			this.waiters.push(waiter);
			const timer = setTimeout(() => {
				const index = this.waiters.indexOf(waiter);
				if (index >= 0) this.waiters.splice(index, 1);
				reject(new Error("rpc wait timed out"));
			}, timeoutMs);
			timer.unref?.();
		});
	}

	async prompt(message: string): Promise<void> {
		await this.request({ type: "prompt", message });
		await this.waitFor((record) => record.type === "agent_settled", this.settleTimeoutMs);
	}

	async abort(): Promise<void> {
		this.process.stdin?.write(`${JSON.stringify({ type: "abort" })}\n`);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.process.stdin?.end();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.process.kill("SIGKILL");
				resolve();
			}, 5_000);
			this.process.on("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			this.process.kill("SIGTERM");
		});
	}
}
