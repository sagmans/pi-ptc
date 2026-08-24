// One model-visible tool. Intermediate binding values stay off the transcript.

import { Type } from "typebox";

import {
	EMPTY_DESCRIPTION_MESSAGE,
	OUTER_OVERFLOW_BYTES_MESSAGE,
	OUTER_OVERFLOW_LINES_MESSAGE,
	TRANSPORT_NAME,
	TRUST_COPY,
} from "./config.ts";
import type { JsonValue } from "./json.ts";
import { type BindingFn, type CodeRunResult, runCode } from "./runtime.ts";

export type PtcParams = {
	code: string;
	description: string;
};

export type PtcExecuteContext = {
	cwd: string;
	signal?: AbortSignal;
};

export type PtcToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: { description: string };
};

const PTC_PARAMETERS = Type.Object({
	code: Type.String({
		description: "Body of an async function. Top-level await and return are legal.",
	}),
	description: Type.String({
		description: "Short UI label for this program, in active voice.",
	}),
});

export function createPtcTool(options: {
	timeoutMs: number;
	maxOutputBytes: number;
	maxOutputLines: number;
	createBindings: (ctx: PtcExecuteContext) => Record<string, BindingFn>;
	run?: typeof runCode;
}) {
	const run = options.run ?? runCode;
	return {
		name: TRANSPORT_NAME,
		label: "PTC",
		description: `Execute a TypeScript program against core tools. ${TRUST_COPY}`,
		promptSnippet: "Run a program against core tools",
		parameters: PTC_PARAMETERS,
		async execute(
			_toolCallId: string,
			params: PtcParams,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: PtcExecuteContext,
		): Promise<PtcToolResult> {
			if (params.description.trim().length === 0) {
				throw new Error(EMPTY_DESCRIPTION_MESSAGE);
			}
			const abortSignal = signal ?? ctx.signal;
			const outcome = await run({
				program: params.code,
				bindings: {
					global: "tools",
					functions: options.createBindings({ cwd: ctx.cwd, signal: abortSignal }),
				},
				signal: abortSignal,
				timeoutMs: options.timeoutMs,
			});
			return {
				content: [{ type: "text", text: serializeOuterResult(outcome, options) }],
				details: { description: params.description },
			};
		},
	};
}

function serializeOuterResult(
	outcome: CodeRunResult,
	limits: { maxOutputBytes: number; maxOutputLines: number },
): string {
	if (outcome.error) {
		const message = "message" in outcome.error ? outcome.error.message : outcome.error.kind;
		throw new Error(`ptc failed (${outcome.error.kind}): ${message}`);
	}
	const outer: { logs: string[]; result?: JsonValue } =
		"result" in outcome ? { logs: outcome.logs, result: outcome.result } : { logs: outcome.logs };
	const text = JSON.stringify(outer);
	if (Buffer.byteLength(text, "utf8") > limits.maxOutputBytes) {
		throw new Error(OUTER_OVERFLOW_BYTES_MESSAGE);
	}
	if (text.split(/\r?\n/).length > limits.maxOutputLines) {
		throw new Error(OUTER_OVERFLOW_LINES_MESSAGE);
	}
	return text;
}
