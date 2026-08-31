import { strict as assert } from "node:assert";
import test from "node:test";

import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
	createCoreBindings,
	createToolBindings,
	type DispatchLogEntry,
	type DispatchProgress,
} from "../src/bridge.ts";
import type { PtcRenderContext } from "../src/renderer.ts";
import { createScheduler } from "../src/scheduler.ts";
import type { ToolCatalogEntry } from "../src/tool-catalog.ts";
import { createPtcTool, type PtcPartialResult } from "../src/transport.ts";
import {
	LIMITS,
	type PtcExecuteReport,
	RAW_CUSTOM_SECRET,
	renderNestedResult,
	TIMER_IDLE_OBSERVATION_MS,
	TIMER_TEST_INTERVAL_MS,
	TIMER_THEME,
	waitForUpdates,
} from "./support/transport-harness.ts";

test("forced timeout, drain, and orphan terminalization preserves raw custom arguments without leaks", async () => {
	for (const failureKind of ["timeout", "dangling-dispatch", "orphan-limit"] as const) {
		const secret = `${RAW_CUSTOM_SECRET}:${failureKind}`;
		const rawArgs = { token: secret, nested: { exact: [1, 2, 3] } };
		let renderedArgs: unknown;
		const logs: DispatchLogEntry[] = [];
		const events: unknown[] = [];
		const reported: DispatchProgress[] = [];
		const updates: PtcPartialResult[] = [];
		const entry: ToolCatalogEntry = {
			name: "custom_terminal",
			definition: {
				renderCall(args: unknown) {
					renderedArgs = args;
					return new Text(`custom ${failureKind} call`, 0, 0);
				},
			},
			executable: {
				parameters: Type.Object({
					token: Type.String(),
					nested: Type.Object({ exact: Type.Array(Type.Number()) }),
				}),
				async execute() {
					return { content: [] };
				},
			},
		};
		const catalog = [entry] as const;
		const executor = {
			async dispatch() {
				return await new Promise<never>(() => undefined);
			},
		};
		const tool = createPtcTool({
			...LIMITS,
			definitionProvider: () => catalog,
			createBindings: (context) =>
				createToolBindings(catalog, executor, createScheduler(1), {
					reportDispatch(progress) {
						reported.push(progress);
						context.reportDispatch?.(progress);
					},
					appendLog: (entry) => logs.push(entry),
					emit: (_name, payload) => events.push(payload),
				}),
			run: async (request) => {
				void request.bindings?.functions.custom_terminal?.(rawArgs, new AbortController().signal);
				await waitForUpdates(updates, 1);
				return { logs: [], error: { kind: failureKind } };
			},
		});

		await assert.rejects(
			() =>
				tool.execute(
					`terminal-${failureKind}`,
					{ code: "return null;", description: `force ${failureKind}` },
					undefined,
					(partial) => updates.push(partial),
					{ cwd: process.cwd() },
				),
			/ptc failed/,
		);
		const terminal = updates.at(-1);
		assert.equal(terminal?.details.dispatches[0]?.status, "err");
		const output = renderNestedResult(tool, terminal as PtcPartialResult);

		assert.deepEqual(renderedArgs, rawArgs);
		assert.match(output, new RegExp(`custom ${failureKind} call`));
		for (const retained of [terminal?.details, terminal?.content, reported, logs, events]) {
			assert.equal(JSON.stringify(retained).includes(secret), false, failureKind);
		}
	}
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
