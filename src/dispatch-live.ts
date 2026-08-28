import type { DispatchProgress, DispatchRenderResult } from "./dispatch-contract.ts";
import type { JsonValue } from "./json.ts";

type MutableLiveDispatchAttachments = {
	arguments?: JsonValue;
	retentionResult?: DispatchRenderResult;
	result?: unknown;
	hasArguments: boolean;
	hasResult: boolean;
};

const liveDispatchAttachments = new WeakMap<object, MutableLiveDispatchAttachments>();

export type LiveDispatchArguments = {
	readonly arguments: JsonValue;
};

export type LiveDispatchResult = {
	readonly result: unknown;
};

export type LiveDispatchRetentionResult = {
	readonly result: DispatchRenderResult;
};

export function attachLiveDispatchArguments(dispatch: DispatchProgress, args: JsonValue): void {
	const attachments = getOrCreateAttachments(dispatch);
	attachments.arguments = args;
	attachments.hasArguments = true;
}

export function attachLiveDispatchResult(
	dispatch: DispatchProgress,
	result: unknown,
	retentionResult: DispatchRenderResult,
): void {
	const attachments = getOrCreateAttachments(dispatch);
	attachments.result = result;
	attachments.hasResult = true;
	attachments.retentionResult = retentionResult;
}

export function attachLiveDispatchRetentionResult(
	dispatch: DispatchProgress,
	result: DispatchRenderResult,
): void {
	getOrCreateAttachments(dispatch).retentionResult = result;
}

export function getLiveDispatchArguments(
	dispatch: DispatchProgress,
): LiveDispatchArguments | undefined {
	const attachments = liveDispatchAttachments.get(dispatch);
	return attachments?.hasArguments ? { arguments: attachments.arguments as JsonValue } : undefined;
}

export function getLiveDispatchResult(dispatch: DispatchProgress): LiveDispatchResult | undefined {
	const attachments = liveDispatchAttachments.get(dispatch);
	return attachments?.hasResult ? { result: attachments.result } : undefined;
}

export function getLiveDispatchRetentionResult(
	dispatch: DispatchProgress,
): LiveDispatchRetentionResult | undefined {
	const result = liveDispatchAttachments.get(dispatch)?.retentionResult;
	return result ? { result } : undefined;
}

export function transferLiveDispatchAttachments(
	source: DispatchProgress,
	target: DispatchProgress,
): void {
	const attachments = liveDispatchAttachments.get(source);
	if (attachments) liveDispatchAttachments.set(target, { ...attachments });
}

function getOrCreateAttachments(dispatch: DispatchProgress): MutableLiveDispatchAttachments {
	const existing = liveDispatchAttachments.get(dispatch);
	if (existing) return existing;
	const attachments: MutableLiveDispatchAttachments = {
		hasArguments: false,
		hasResult: false,
	};
	liveDispatchAttachments.set(dispatch, attachments);
	return attachments;
}
