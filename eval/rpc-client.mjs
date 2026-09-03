// Strict LF-only JSONL RPC client for Pi. Node readline is not
// protocol-compliant because it also splits on U+2028/U+2029.

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 600_000;

export class PiRpcClient {
	constructor(childProcess, options = {}) {
		this.process = childProcess;
		this.stderr = [];
		this.events = [];
		this.nextRequestId = 1;
		this.lineBuffer = "";
		this.decoder = new StringDecoder("utf8");
		this.waiters = [];
		this.closed = false;
		this.responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
		this.settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
		childProcess.stdout.on("data", (chunk) => this.onStdoutChunk(chunk));
		childProcess.stderr.on("data", (chunk) => {
			this.stderr.push(String(chunk));
		});
		childProcess.on("exit", () => {
			this.closed = true;
			this.flushWaiters(new Error("pi rpc process exited"));
		});
	}

	static spawn(args, options = {}) {
		const childProcess = spawn(options.piBinary ?? "pi", ["--mode", "rpc", ...args], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		return new PiRpcClient(childProcess, options);
	}

	onStdoutChunk(chunk) {
		this.lineBuffer +=
			typeof chunk === "string" ? this.decoder.write(chunk) : this.decoder.write(chunk);
		while (true) {
			const newlineIndex = this.lineBuffer.indexOf("\n");
			if (newlineIndex === -1) break;
			let line = this.lineBuffer.slice(0, newlineIndex);
			this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.length === 0) continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			this.events.push(record);
			this.flushWaiters();
		}
	}

	flushWaiters(failure) {
		if (failure) {
			for (const waiter of this.waiters.splice(0)) waiter.reject(failure);
			return;
		}
		this.waiters = this.waiters.filter((waiter) => !waiter.tryResolve(this.events));
	}

	send(command) {
		const id = `eval-${this.nextRequestId}`;
		this.nextRequestId += 1;
		this.process.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		return id;
	}

	async request(command) {
		const id = this.send(command);
		const response = await this.waitFor((record) => record.type === "response" && record.id === id);
		if (response.success !== true) {
			throw new Error(`rpc command failed (${command.type}): ${response.error}`);
		}
		return response.data;
	}

	waitFor(predicate, timeoutMs = this.responseTimeoutMs) {
		const existing = this.events.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const waiter = {
				predicate,
				reject,
				tryResolve: (events) => {
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

	async prompt(message) {
		await this.request({ type: "prompt", message });
		await this.waitFor((record) => record.type === "agent_settled", this.settleTimeoutMs);
	}

	async abort() {
		this.process.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
	}

	async close() {
		if (this.closed) return;
		this.process.stdin.end();
		await new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.process.kill("SIGKILL");
				resolve(undefined);
			}, 5_000);
			this.process.on("exit", () => {
				clearTimeout(timer);
				resolve(undefined);
			});
			this.process.kill("SIGTERM");
		});
	}
}
