import { strict as assert } from "node:assert";
import test from "node:test";

import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";

import {
	createCoreBindings,
	type DispatchProgress,
	type DispatchRenderResult,
} from "../src/bridge.ts";
import { SHIPPED_PTC_CONFIG, TRUST_COPY } from "../src/config.ts";
import type { PtcRenderContext } from "../src/renderer.ts";
import { createScheduler } from "../src/scheduler.ts";
import { createPtcTool, type PtcPartialResult } from "../src/transport.ts";

const CUSTOM_DRAIN_TIMEOUT_MS = 321;
const CUSTOM_MAX_DISPATCHES = 37;
const CUSTOM_MAX_ORPHANED_BINDINGS = 4;
const CUSTOM_MAX_OUTPUT_BYTES = 1234;
const CUSTOM_MAX_OUTPUT_LINES = 56;
const CUSTOM_MAX_PERSISTED_DETAILS_BYTES = 2345;
const SCALING_DISPATCH_COUNT = 100;
const SCALING_DESCRIPTION = "inspect dispatch scaling";
const SCALING_ACCESS_BOUND_PER_DISPATCH = 20;
const RETENTION_RENDER_BUDGET_BYTES = 64;
const OVERSIZED_RETAINED_TEXT = "r".repeat(RETENTION_RENDER_BUDGET_BYTES + 1);
const FIRST_RETAINED_RESULT_TEXT = "first retained result";
const SECOND_RETAINED_RESULT_TEXT = "second retained resul";
const FIRST_RETAINED_RESULT = {
	content: [{ type: "text", text: FIRST_RETAINED_RESULT_TEXT }],
	isError: false,
} satisfies DispatchRenderResult;
const SECOND_RETAINED_RESULT = {
	content: [{ type: "text", text: SECOND_RETAINED_RESULT_TEXT }],
	isError: false,
} satisfies DispatchRenderResult;
const SINGLE_RETAINED_RESULT_BUDGET_BYTES = Buffer.byteLength(
	JSON.stringify(FIRST_RETAINED_RESULT),
	"utf8",
);
const HOSTILE_RENDER_DETAILS_MESSAGE = "hostile render details";
const TIMER_TEST_INTERVAL_MS = 5;
const TIMER_IDLE_OBSERVATION_MS = 30;
const OVERSIZED_FAILURE_MESSAGE = "failure".repeat(1000);

type PtcExecuteReport = (progress: DispatchProgress) => void;

const TIMER_THEME = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const LIMITS = {
	timeoutMs: 2000,
	maxDispatches: SHIPPED_PTC_CONFIG.maxDispatches,
	maxOutputBytes: 51200,
	maxOutputLines: 2000,
};

initTheme(undefined, false);

test("ptc description names bash-equivalent trust", () => {
	const tool = createPtcTool({
		...LIMITS,
		createBindings: () => ({}),
	});
	assert.match(tool.description, new RegExp(TRUST_COPY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.equal(tool.name, "ptc");
});

test("ptc returns logs and a curated result", async () => {
	const tool = createPtcTool({
		...LIMITS,
		createBindings: () => ({
			echo: async (args) => args,
		}),
	});
	const result = await tool.execute(
		"call-1",
		{ code: 'console.log("hi"); return await tools.echo({ n: 2 });', description: "echo" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	assert.equal(result.content[0]?.type, "text");
	assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), {
		logs: ["hi"],
		result: { n: 2 },
	});
});

test("ptc rejects an oversized outer result", async () => {
	const tool = createPtcTool({
		timeoutMs: LIMITS.timeoutMs,
		maxDispatches: LIMITS.maxDispatches,
		maxOutputBytes: 16,
		maxOutputLines: 2000,
		createBindings: () => ({}),
	});
	await assert.rejects(
		() =>
			tool.execute(
				"call-2",
				{ code: 'return "0123456789abcdef";', description: "overflow" },
				undefined,
				undefined,
				{ cwd: process.cwd() },
			),
		/outer result exceeds/,
	);
});

test("ptc bounds worker failure messages before Pi persists them", async () => {
	const tool = createPtcTool({
		...LIMITS,
		maxOutputBytes: CUSTOM_MAX_OUTPUT_BYTES,
		maxOutputLines: CUSTOM_MAX_OUTPUT_LINES,
		createBindings: () => ({}),
	});
	let rejection: Error | undefined;

	try {
		await tool.execute(
			"call-large-failure",
			{
				code: `throw new Error(${JSON.stringify(OVERSIZED_FAILURE_MESSAGE)});`,
				description: "bound a worker failure",
			},
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);
	} catch (error) {
		rejection = error as Error;
	}

	assert.equal(rejection?.message, "ptc failed (output-limit): output-limit");
	assert.ok(Buffer.byteLength(rejection?.message ?? "", "utf8") <= CUSTOM_MAX_OUTPUT_BYTES);
});

test("ptc forwards output and dispatch limits into the runtime seam", async () => {
	let captured:
		| {
				drainTimeoutMs?: number;
				maxBindingCalls?: number;
				maxOrphanedBindings?: number;
				maxOutputBytes?: number;
				maxOutputLines?: number;
		  }
		| undefined;
	const tool = createPtcTool({
		timeoutMs: LIMITS.timeoutMs,
		drainTimeoutMs: CUSTOM_DRAIN_TIMEOUT_MS,
		maxDispatches: CUSTOM_MAX_DISPATCHES,
		maxOrphanedBindings: CUSTOM_MAX_ORPHANED_BINDINGS,
		maxOutputBytes: CUSTOM_MAX_OUTPUT_BYTES,
		maxOutputLines: CUSTOM_MAX_OUTPUT_LINES,
		maxPersistedDetailsBytes: CUSTOM_MAX_PERSISTED_DETAILS_BYTES,
		createBindings: () => ({}),
		run: async (request) => {
			captured = request;
			return { logs: [], result: null };
		},
	});

	await tool.execute(
		"call-limits",
		{ code: "return null;", description: "check limits" },
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);

	assert.equal(captured?.drainTimeoutMs, CUSTOM_DRAIN_TIMEOUT_MS);
	assert.equal(captured?.maxBindingCalls, CUSTOM_MAX_DISPATCHES);
	assert.equal(captured?.maxOrphanedBindings, CUSTOM_MAX_ORPHANED_BINDINGS);
	assert.equal(captured?.maxOutputBytes, CUSTOM_MAX_OUTPUT_BYTES);
	assert.equal(captured?.maxOutputLines, CUSTOM_MAX_OUTPUT_LINES);
});

test("ptc terminalizes and quarantines dispatches left active at runtime settlement", async () => {
	const updates: PtcPartialResult[] = [];
	let reportDispatch: PtcExecuteReport | undefined;
	const tool = createPtcTool({
		...LIMITS,
		createBindings: (ctx) => {
			reportDispatch = ctx.reportDispatch;
			return {};
		},
		run: async () => {
			reportDispatch?.({
				id: 1,
				name: "read",
				args: { path: "stalled.txt" },
				status: "start",
			});
			return { logs: [], error: { kind: "timeout" } };
		},
	});

	await assert.rejects(
		() =>
			tool.execute(
				"call-stalled",
				{ code: "return null;", description: "settle stalled dispatch" },
				undefined,
				(partial) => updates.push(partial),
				{ cwd: process.cwd() },
			),
		/timeout/,
	);

	assert.equal(updates.at(-1)?.details.dispatches[0]?.status, "err");
	const updateCountAfterSettlement = updates.length;
	reportDispatch?.({
		id: 1,
		name: "read",
		args: { path: "stalled.txt" },
		status: "ok",
		result: { content: [{ type: "text", text: "late" }], isError: false },
	});
	assert.equal(updates.length, updateCountAfterSettlement);
});

test("ptc abort reaches an active core executor before settlement", async () => {
	let markExecutorStarted!: () => void;
	const executorStarted = new Promise<void>((resolve) => {
		markExecutorStarted = resolve;
	});
	let executorSignal: AbortSignal | undefined;
	const tool = createPtcTool({
		...LIMITS,
		createBindings: () =>
			createCoreBindings({
				execute: async (_name, _args, signal) => {
					executorSignal = signal;
					markExecutorStarted();
					if (signal && !signal.aborted) {
						await new Promise<void>((resolve) => {
							signal.addEventListener("abort", () => resolve(), { once: true });
						});
					}
					return { content: [] };
				},
				scheduler: createScheduler(1),
			}),
	});
	const controller = new AbortController();
	const pending = tool.execute(
		"call-3",
		{ code: 'await tools.read({ path: "note.txt" }); return 1;', description: "hang" },
		controller.signal,
		undefined,
		{ cwd: process.cwd() },
	);
	await executorStarted;
	controller.abort();
	await assert.rejects(pending, /abort/);
	assert.equal(executorSignal?.aborted, true);
});

test("terminal abort updates clear the native bash timer before outer rejection", {
	concurrency: false,
}, async () => {
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	const activeIntervals = new Set<ReturnType<typeof setInterval>>();
	let intervalCreations = 0;
	let intervalClears = 0;
	globalThis.setInterval = ((...parameters: Parameters<typeof setInterval>) => {
		const [callback, _delay, ...args] = parameters;
		intervalCreations += 1;
		const handle = originalSetInterval(callback, TIMER_TEST_INTERVAL_MS, ...args);
		activeIntervals.add(handle);
		return handle;
	}) as typeof setInterval;
	globalThis.clearInterval = ((handle) => {
		intervalClears += 1;
		activeIntervals.delete(handle as ReturnType<typeof setInterval>);
		originalClearInterval(handle);
	}) as typeof clearInterval;

	try {
		let markExecutorStarted!: () => void;
		const executorStarted = new Promise<void>((resolve) => {
			markExecutorStarted = resolve;
		});
		let rejectionObserved = false;
		let terminalObserved = false;
		let invalidations = 0;
		const renderContext: PtcRenderContext = {
			toolCallId: "timer-abort",
			cwd: process.cwd(),
			state: {},
			invalidate: () => {
				invalidations += 1;
			},
			lastComponent: undefined,
			expanded: false,
			showImages: false,
			isError: false,
		};
		const tool = createPtcTool({
			...LIMITS,
			createBindings: (ctx) =>
				createCoreBindings({
					execute: async (_name, _args, signal, onUpdate) => {
						onUpdate?.({ content: [{ type: "text", text: "working" }] });
						markExecutorStarted();
						await new Promise<void>((_resolve, reject) => {
							if (signal?.aborted) {
								reject(new Error("aborted"));
								return;
							}
							signal?.addEventListener("abort", () => reject(new Error("aborted")), {
								once: true,
							});
						});
						return { content: [] };
					},
					reportDispatch: ctx.reportDispatch,
					scheduler: createScheduler(1),
				}),
		});
		const controller = new AbortController();
		const pending = tool.execute(
			"timer-abort",
			{
				code: 'await tools.bash({ command: "wait" });',
				description: "abort timed bash",
			},
			controller.signal,
			(partial) => {
				const status = partial.details.dispatches[0]?.status;
				tool.renderResult(
					partial,
					{ expanded: false, isPartial: status === "start" },
					TIMER_THEME,
					renderContext,
				);
				if (status === "err") {
					terminalObserved = true;
					assert.equal(rejectionObserved, false);
				}
			},
			{ cwd: process.cwd() },
		);

		await executorStarted;
		assert.equal(intervalCreations, 1);
		controller.abort();
		await assert.rejects(pending, /abort/i);
		rejectionObserved = true;
		assert.equal(terminalObserved, true);
		assert.equal(intervalClears, 1);
		assert.equal(activeIntervals.size, 0);
		const invalidationsAfterSettlement = invalidations;
		await new Promise((resolve) => setTimeout(resolve, TIMER_IDLE_OBSERVATION_MS));
		assert.equal(invalidations, invalidationsAfterSettlement);
	} finally {
		for (const handle of activeIntervals) originalClearInterval(handle);
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	}
});

async function waitForUpdates(updates: unknown[], count: number, timeoutMs = 1000): Promise<void> {
	const started = Date.now();
	while (updates.length < count) {
		if (Date.now() - started > timeoutMs) {
			throw new Error(`timed out waiting for ${count} updates, got ${updates.length}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("ptc keeps 100 progress payloads proportional to the report count", async () => {
	const updates: PtcPartialResult[] = [];
	let propertyAccesses = 0;
	let reportDispatch: PtcExecuteReport | undefined;
	const tool = createPtcTool({
		...LIMITS,
		createBindings: (ctx) => {
			reportDispatch = ctx.reportDispatch;
			return {};
		},
		run: async () => {
			for (let id = SCALING_DISPATCH_COUNT; id >= 1; id -= 1) {
				const args = new Proxy(
					{ path: `file-${id}.txt` },
					{
						get(target, key, receiver) {
							propertyAccesses += 1;
							return Reflect.get(target, key, receiver);
						},
						ownKeys(target) {
							propertyAccesses += 1;
							return Reflect.ownKeys(target);
						},
					},
				);
				const result = new Proxy(
					{
						content: [{ type: "text", text: `result-${id}` }],
						isError: false,
					},
					{
						get(target, key, receiver) {
							propertyAccesses += 1;
							return Reflect.get(target, key, receiver);
						},
					},
				) as DispatchRenderResult;
				reportDispatch?.({ id, name: "read", args, status: "ok", result });
			}
			return { logs: [], result: null };
		},
	});

	const result = await tool.execute(
		"call-scaling",
		{ code: "return null;", description: SCALING_DESCRIPTION },
		undefined,
		(partial) => updates.push(partial),
		{ cwd: process.cwd() },
	);

	assert.equal(updates.length, SCALING_DISPATCH_COUNT);
	assert.equal(
		updates.reduce((count, update) => count + update.details.dispatches.length, 0),
		SCALING_DISPATCH_COUNT,
	);
	assert.equal(
		updates.reduce((count, update) => count + (update.content[0]?.text.split("\n").length ?? 0), 0),
		SCALING_DISPATCH_COUNT,
	);
	for (const update of updates) {
		assert.equal(update.details.mode, "delta");
		assert.equal(update.details.dispatches.length, 1);
	}
	assert.equal(result.details.mode, "snapshot");
	assert.deepEqual(
		result.details.dispatches.map((dispatch) => dispatch.id),
		Array.from({ length: SCALING_DISPATCH_COUNT }, (_, index) => index + 1),
	);
	assert.ok(propertyAccesses <= SCALING_ACCESS_BOUND_PER_DISPATCH * SCALING_DISPATCH_COUNT);
});

test("render projection failures do not fail dispatch execution", async () => {
	const updates: PtcPartialResult[] = [];
	let reportDispatch: PtcExecuteReport | undefined;
	const hostileDetails = new Proxy(
		{},
		{
			ownKeys: () => {
				throw new Error(HOSTILE_RENDER_DETAILS_MESSAGE);
			},
		},
	);
	const tool = createPtcTool({
		...LIMITS,
		createBindings: (ctx) => {
			reportDispatch = ctx.reportDispatch;
			return {};
		},
		run: async () => {
			reportDispatch?.({
				id: 1,
				name: "bash",
				args: { command: "printf safe" },
				status: "ok",
				preview: "safe preview",
				result: { content: [], details: hostileDetails, isError: false },
			});
			return { logs: [], result: "completed" };
		},
	});

	const result = await tool.execute(
		"call-hostile-render",
		{ code: "return null;", description: "ignore hostile render details" },
		undefined,
		(partial) => updates.push(partial),
		{ cwd: process.cwd() },
	);

	const expectedDispatch = {
		id: 1,
		name: "bash",
		args: { command: "printf safe" },
		status: "ok",
		preview: "safe preview",
		renderOmitted: "incompatible",
	};
	assert.deepEqual(result.details.dispatches, [expectedDispatch]);
	assert.deepEqual(updates[0]?.details.dispatches, [expectedDispatch]);
	assert.ok((result.details.compatibilityError?.length ?? 0) > 0);
});

test("transport accounts for retained render projections across dispatch ids", async () => {
	const updates: PtcPartialResult[] = [];
	let reportDispatch: PtcExecuteReport | undefined;
	const tool = createPtcTool({
		...LIMITS,
		maxRenderDetailsBytes: SINGLE_RETAINED_RESULT_BUDGET_BYTES,
		createBindings: (ctx) => {
			reportDispatch = ctx.reportDispatch;
			return {};
		},
		run: async () => {
			reportDispatch?.({
				id: 1,
				name: "read",
				args: { path: "first.txt" },
				status: "ok",
				result: FIRST_RETAINED_RESULT,
			});
			reportDispatch?.({
				id: 2,
				name: "read",
				args: { path: "second.txt" },
				status: "ok",
				result: SECOND_RETAINED_RESULT,
			});
			return { logs: [], result: null };
		},
	});

	const result = await tool.execute(
		"call-retained-accounting",
		{ code: "return null;", description: "account retained projections" },
		undefined,
		(partial) => updates.push(partial),
		{ cwd: process.cwd() },
	);

	assert.equal(
		Buffer.byteLength(JSON.stringify(FIRST_RETAINED_RESULT), "utf8"),
		SINGLE_RETAINED_RESULT_BUDGET_BYTES,
	);
	assert.equal(
		Buffer.byteLength(JSON.stringify(SECOND_RETAINED_RESULT), "utf8"),
		SINGLE_RETAINED_RESULT_BUDGET_BYTES,
	);
	assert.deepEqual(updates[0]?.details.dispatches[0]?.result, FIRST_RETAINED_RESULT);
	assert.deepEqual(updates[1]?.details.dispatches, [
		{
			id: 2,
			name: "read",
			args: { path: "second.txt" },
			status: "ok",
			renderOmitted: "budget",
		},
	]);
	assert.deepEqual(result.details.dispatches, [
		{
			id: 1,
			name: "read",
			args: { path: "first.txt" },
			status: "ok",
			result: FIRST_RETAINED_RESULT,
		},
		{
			id: 2,
			name: "read",
			args: { path: "second.txt" },
			status: "ok",
			renderOmitted: "budget",
		},
	]);
});

test("transport does not revisit raw results after retaining a bounded projection", async () => {
	const updates: PtcPartialResult[] = [];
	let textReads = 0;
	let textReadsAfterReport = 0;
	let reportDispatch: PtcExecuteReport | undefined;
	const contentBlock = {
		type: "text",
		get text() {
			textReads += 1;
			return OVERSIZED_RETAINED_TEXT;
		},
	};
	const tool = createPtcTool({
		...LIMITS,
		maxRenderDetailsBytes: RETENTION_RENDER_BUDGET_BYTES,
		createBindings: (ctx) => {
			reportDispatch = ctx.reportDispatch;
			return {};
		},
		run: async () => {
			reportDispatch?.({
				id: 1,
				name: "read",
				args: { path: "large.txt" },
				status: "ok",
				result: { content: [contentBlock], isError: false },
			});
			textReadsAfterReport = textReads;
			return { logs: [], result: null };
		},
	});

	const result = await tool.execute(
		"call-retention",
		{ code: "return null;", description: "retain bounded projections" },
		undefined,
		(partial) => updates.push(partial),
		{ cwd: process.cwd() },
	);

	assert.equal(textReads, textReadsAfterReport);
	assert.deepEqual(result.details.dispatches, [
		{
			id: 1,
			name: "read",
			args: { path: "large.txt" },
			status: "ok",
			renderOmitted: "budget",
		},
	]);
	assert.equal(JSON.stringify(updates).includes(OVERSIZED_RETAINED_TEXT), false);
	assert.equal(JSON.stringify(result.details).includes(OVERSIZED_RETAINED_TEXT), false);
});

test("ptc streams dispatch start then ok through onUpdate", async () => {
	const updates: Array<{ content: Array<{ text: string }>; details: { dispatches: unknown[] } }> =
		[];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const secret = "SECRET_FILE_BYTES";
	const tool = createPtcTool({
		...LIMITS,
		createBindings: (ctx) =>
			createCoreBindings({
				execute: async () => {
					await gate;
					return { content: [{ type: "text", text: secret }] };
				},
				scheduler: createScheduler(2),
				reportDispatch: ctx.reportDispatch,
			}),
	});
	const pending = tool.execute(
		"call-4",
		{
			code: 'const r = await tools.read({ path: "note.txt" }); return r.text.length;',
			description: "read note",
		},
		undefined,
		(partial) => {
			updates.push(partial as (typeof updates)[number]);
		},
		{ cwd: process.cwd() },
	);
	await waitForUpdates(updates, 1);
	assert.equal(updates[0]?.content[0]?.text, "read … note.txt");
	assert.equal(JSON.stringify(updates).includes(secret), false);
	release();
	const result = await pending;
	assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), {
		logs: [],
		result: secret.length,
	});
	const persistedDispatch = {
		id: 1,
		name: "read",
		args: { path: "note.txt" },
		status: "ok",
		result: {
			content: [{ type: "text", text: secret }],
			isError: false,
		},
	};
	assert.deepEqual(result.details.dispatches, [persistedDispatch]);
	assert.deepEqual(updates.at(-1)?.details.dispatches, [persistedDispatch]);
	assert.equal(updates.at(-1)?.content[0]?.text, "read ok note.txt");
});
