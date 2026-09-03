// Model-visible outer payload serialization. Only bounded text leaves this
// module; byte accounting uses serialized JSON while line accounting stays
// semantic so JSON escaping cannot bypass configured limits.

import { formatCodeRunFailure } from "./failure-guidance.ts";
import type { JsonValue } from "./json.ts";
import * as outputLimit from "./output-limit.ts";
import {
	logicalTextLineCount,
	measureSerializedJson,
	outerLogicalLineCount,
} from "./output-measure.ts";
import type { CodeRunResult } from "./runtime-contract.ts";

export type OutputLimits = { maxOutputBytes: number; maxOutputLines: number };

export function serializeOuterResult(outcome: CodeRunResult, limits: OutputLimits): string {
	if (outcome.error) throw new Error(describeBoundedRunFailure(outcome.error, limits));
	const outer: { logs: string[]; result?: JsonValue } =
		"result" in outcome ? { logs: outcome.logs, result: outcome.result } : { logs: outcome.logs };
	const { text, bytes } = measureSerializedJson(outer);
	if (bytes > limits.maxOutputBytes) {
		throw new Error(
			outputLimit.describe(
				outputLimit.OUTER_RESULT_SUBJECT,
				outputLimit.MAX_OUTPUT_BYTES_NAME,
				bytes,
				limits.maxOutputBytes,
			),
		);
	}
	const lines = outerLogicalLineCount(outcome);
	if (lines > limits.maxOutputLines) {
		throw new Error(
			outputLimit.describe(
				outputLimit.OUTER_RESULT_SUBJECT,
				outputLimit.MAX_OUTPUT_LINES_NAME,
				lines,
				limits.maxOutputLines,
			),
		);
	}
	return text;
}

function describeBoundedRunFailure(
	error: NonNullable<CodeRunResult["error"]>,
	limits: OutputLimits,
): string {
	const failure = formatCodeRunFailure(error);
	try {
		assertOuterResultWithinLimits(failure, limits);
		return failure;
	} catch (limitError) {
		const message = limitError instanceof Error ? limitError.message : String(limitError);
		const fallback = formatCodeRunFailure({ kind: "output-limit", message });
		assertOuterResultWithinLimits(fallback, limits);
		return fallback;
	}
}

export function assertOuterResultWithinLimits(text: string, limits: OutputLimits): void {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > limits.maxOutputBytes) {
		throw new Error(
			outputLimit.describe(
				outputLimit.OUTER_RESULT_SUBJECT,
				outputLimit.MAX_OUTPUT_BYTES_NAME,
				bytes,
				limits.maxOutputBytes,
			),
		);
	}
	const lines = logicalTextLineCount(text);
	if (lines > limits.maxOutputLines) {
		throw new Error(
			outputLimit.describe(
				outputLimit.OUTER_RESULT_SUBJECT,
				outputLimit.MAX_OUTPUT_LINES_NAME,
				lines,
				limits.maxOutputLines,
			),
		);
	}
}
