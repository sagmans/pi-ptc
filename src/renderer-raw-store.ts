import { isCoreToolName, SHIPPED_PTC_CONFIG } from "./config.ts";
import type { DispatchProgress, DispatchRenderResult } from "./dispatch-contract.ts";
import { projectLiveDisplayArguments } from "./dispatch-details.ts";
import {
	getLiveDispatchArguments,
	getLiveDispatchResult,
	getLiveDispatchRetentionResult,
} from "./dispatch-live.ts";
import { projectRenderResult } from "./dispatch-retention.ts";
import type { PtcLiveRenderAttachment } from "./renderer-contract.ts";

export const liveRenderAttachments = new WeakMap<
	object,
	ReadonlyMap<number, PtcLiveRenderAttachment>
>();

export function attachPtcRenderDispatches(
	details: object,
	dispatches: readonly DispatchProgress[],
): void {
	liveRenderAttachments.set(
		details,
		new Map(dispatches.map((dispatch) => [dispatch.id, createLiveAttachment(dispatch)])),
	);
}

export function createLiveAttachment(dispatch: DispatchProgress): PtcLiveRenderAttachment {
	const core = isCoreToolName(dispatch.name);
	const liveArguments = getLiveDispatchArguments(dispatch)?.arguments ?? dispatch.args;
	const result = core ? undefined : getLiveDispatchResult(dispatch);
	const args = core ? projectLiveDisplayArguments(dispatch.name, liveArguments) : liveArguments;
	if (core) return { args, hasResult: false };
	let retentionResult: DispatchRenderResult | undefined;
	let projectedResult: unknown;
	try {
		retentionResult = getLiveDispatchRetentionResult(dispatch)?.result ?? dispatch.result;
		projectedResult = result ? result.result : dispatch.result;
	} catch {
		return { args, hasResult: false };
	}
	const displayResult = createLiveDisplayResult(retentionResult);
	return projectedResult === undefined
		? { args, displayResult, hasResult: false }
		: { args, displayResult, hasResult: true, result: projectedResult };
}

function createLiveDisplayResult(
	result: DispatchRenderResult | undefined,
): PtcLiveRenderAttachment["displayResult"] {
	if (!result) return undefined;
	let content: unknown;
	let isError: unknown;
	try {
		content = Reflect.get(result, "content");
		isError = Reflect.get(result, "isError");
	} catch {
		return undefined;
	}
	const projection = projectRenderResult(
		{ content, isError: isError === true },
		SHIPPED_PTC_CONFIG.maxRenderDetailsBytes,
	);
	return projection.kind === "accepted" ? projection.result : undefined;
}
