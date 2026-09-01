import { strict as assert } from "node:assert";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";

import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { TRUST_COPY } from "../src/config.ts";
import type { DispatchLogEntry, DispatchProgress } from "../src/dispatch-contract.ts";
import {
	type CapturedPiSession,
	type PiRuntimeActionsInstallation,
	type PiRuntimeEventFinalizersInstallation,
	SUPPORTED_PI_VERSION,
} from "../src/pi-runtime.ts";
import { createPiToolArgumentPreparer } from "../src/pi-runtime-arguments.ts";
import { createScheduler } from "../src/scheduler.ts";
import { createToolBindings } from "../src/tool-bindings.ts";
import type { ToolCatalogEntry } from "../src/tool-catalog.ts";
import { createToolExecutor } from "../src/tool-executor.ts";
import { createPtcTool, serializeOuterResult } from "../src/transport.ts";
import {
	CUSTOM_CALL_MARKER,
	CUSTOM_RESULT_MARKER,
	LIMITS,
	RAW_CUSTOM_DETAILS_MARKER,
	RAW_CUSTOM_SECRET,
	renderNestedResult,
} from "./support/transport-harness.ts";

test("ptc description names bash-equivalent trust and active runtime tools", () => {
	const tool = createPtcTool({
		...LIMITS,
		createBindings: () => ({}),
	});
	assert.match(tool.description, new RegExp(TRUST_COPY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(tool.description, /active runtime tools/);
	assert.equal(tool.promptSnippet, "Run a program against active runtime tools");
	assert.equal(tool.name, "ptc");
});

test("uncaught delivery failures warn that retry may repeat effects", () => {
	assert.throws(
		() =>
			serializeOuterResult(
				{
					logs: [],
					error: { kind: "result-delivery", message: "delivery failed" },
				},
				LIMITS,
			),
		/execution may have succeeded; retry may repeat effects: delivery failed/,
	);
});

test("live custom renderers receive raw args and finalized non-JSON results without leaks", async () => {
	const cyclicDetails: Record<string, unknown> = { marker: RAW_CUSTOM_DETAILS_MARKER };
	cyclicDetails.self = cyclicDetails;
	let renderedArgs: unknown;
	let renderedResult: unknown;
	let renderedPartial: boolean | undefined;
	let renderedError: boolean | undefined;
	const definition = {
		name: "custom_tool",
		renderShell: "self",
		renderCall(args: unknown) {
			renderedArgs = args;
			return new Text(CUSTOM_CALL_MARKER, 0, 0);
		},
		renderResult(
			result: unknown,
			options: { isPartial: boolean },
			_theme: Theme,
			context: { isError: boolean },
		) {
			renderedResult = result;
			renderedPartial = options.isPartial;
			renderedError = context.isError;
			return new Text(CUSTOM_RESULT_MARKER, 0, 0);
		},
	};
	const entry: ToolCatalogEntry = {
		name: "custom_tool",
		definition,
		executable: {
			parameters: Type.Object({
				token: Type.String(),
				nested: Type.Object({ exact: Type.Array(Type.Number()) }),
			}),
			async execute() {
				return {
					content: [{ type: "text", text: "before hook" }],
					details: { phase: "before" },
				};
			},
		},
	};
	const catalog = [entry] as const;
	const session: CapturedPiSession = {
		version: SUPPORTED_PI_VERSION,
		extensionRunner: {
			createContext: () => ({}),
			emit: async () => undefined,
		},
		sharedRuntime: {
			getActiveTools: () => [entry.name],
			setActiveTools() {},
			refreshTools() {},
		},
		toolRegistry: new Map([[entry.name, entry.executable]]),
		beforeToolCall: async () => undefined,
		afterToolCall: async () => ({
			content: [{ type: "text", text: "after hook" }],
			details: cyclicDetails,
		}),
		getToolDefinition: () => definition,
		prepareToolArguments: createPiToolArgumentPreparer(new Map([[entry.name, entry.executable]])),
		installRuntimeActions(): PiRuntimeActionsInstallation {
			throw new Error("not used");
		},
		installRuntimeEventFinalizers(): PiRuntimeEventFinalizersInstallation {
			throw new Error("not used");
		},
	};
	const executor = createToolExecutor({ catalog, session });
	const logs: DispatchLogEntry[] = [];
	const events: unknown[] = [];
	const reported: DispatchProgress[] = [];
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
	});
	const result = await tool.execute(
		"custom-live",
		{
			code: `return await tools.custom_tool({ token: ${JSON.stringify(RAW_CUSTOM_SECRET)}, nested: { exact: [1, 2, 3] } });`,
			description: "run custom tool",
		},
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);
	const output = renderNestedResult(tool, result);
	const rawResult = renderedResult as { content: Array<{ text: string }>; details: unknown };

	assert.deepEqual(renderedArgs, {
		token: RAW_CUSTOM_SECRET,
		nested: { exact: [1, 2, 3] },
	});
	assert.equal(rawResult.content[0]?.text, "after hook");
	assert.equal(rawResult.details, cyclicDetails);
	assert.equal(renderedPartial, false);
	assert.equal(renderedError, false);
	assert.match(output, new RegExp(CUSTOM_CALL_MARKER));
	assert.match(output, new RegExp(CUSTOM_RESULT_MARKER));
	assert.doesNotMatch(output, /before hook/);
	assert.equal(result.details.dispatches[0]?.renderOmitted, "incompatible");
	assert.equal(JSON.stringify(result.details).includes(RAW_CUSTOM_SECRET), false);
	assert.equal(result.content[0]?.text.includes(RAW_CUSTOM_SECRET), false);
	assert.equal(JSON.stringify(logs).includes(RAW_CUSTOM_SECRET), false);
	assert.equal(JSON.stringify(events).includes(RAW_CUSTOM_SECRET), false);
	const serializedReports = JSON.stringify(reported);
	assert.equal(serializedReports.includes(RAW_CUSTOM_SECRET), false);
	assert.equal(serializedReports.includes(RAW_CUSTOM_DETAILS_MARKER), false);

	renderedArgs = undefined;
	renderedResult = undefined;
	const clonedResult = JSON.parse(JSON.stringify(result)) as typeof result;
	const clonedOutput = renderNestedResult(tool, clonedResult, "custom-live");
	assert.deepEqual(renderedArgs, {
		token: "[REDACTED]",
		nested: { exact: [1, 2, 3] },
	});
	assert.notEqual(renderedResult, cyclicDetails);
	assert.equal(JSON.stringify(renderedResult).includes(RAW_CUSTOM_DETAILS_MARKER), false);
	assert.equal(clonedOutput.includes(RAW_CUSTOM_SECRET), false);
	assert.equal(clonedOutput.includes(RAW_CUSTOM_DETAILS_MARKER), false);
});
