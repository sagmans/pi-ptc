import { strict as assert } from "node:assert";
import test from "node:test";

import { createCoreBindings, type DispatchRenderResult } from "../src/bridge.ts";
import { createScheduler } from "../src/scheduler.ts";
import { createPtcTool, type PtcPartialResult } from "../src/transport.ts";
import {
	FIRST_RETAINED_RESULT,
	HOSTILE_RENDER_DETAILS_MESSAGE,
	LIMITS,
	OVERSIZED_RETAINED_TEXT,
	type PtcExecuteReport,
	RETENTION_RENDER_BUDGET_BYTES,
	SCALING_ACCESS_BOUND_PER_DISPATCH,
	SCALING_DESCRIPTION,
	SCALING_DISPATCH_COUNT,
	SECOND_RETAINED_RESULT,
	SINGLE_RETAINED_RESULT_BUDGET_BYTES,
	waitForUpdates,
} from "./support/transport-harness.ts";

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
