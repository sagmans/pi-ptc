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

const INITIAL_RAW_RENDER_EPOCH = 0;
const RAW_RENDER_EPOCH_INCREMENT = 1;

export type RawRenderToken = { readonly epoch: number };

export type RawRenderStore = {
	begin(): RawRenderToken;
	attach(details: object, dispatches: readonly DispatchProgress[], token: RawRenderToken): void;
	claim(details: object): ReadonlyMap<number, PtcLiveRenderAttachment> | undefined;
	clear(): void;
};

export function createRawRenderStore(): RawRenderStore {
	let epoch = INITIAL_RAW_RENDER_EPOCH;
	let entries = new WeakMap<object, ReadonlyMap<number, PtcLiveRenderAttachment>>();
	return Object.freeze({
		begin() {
			return Object.freeze({ epoch });
		},
		attach(details, dispatches, token) {
			if (token.epoch !== epoch) return;
			const attachmentEpoch = epoch;
			let attachments: ReadonlyMap<number, PtcLiveRenderAttachment>;
			const isCurrent = (): boolean =>
				attachmentEpoch === epoch && entries.get(details) === attachments;
			attachments = new Map(
				dispatches.map((dispatch) => [dispatch.id, createLiveAttachment(dispatch, isCurrent)]),
			);
			entries.set(details, attachments);
		},
		claim(details) {
			return entries.get(details);
		},
		clear() {
			epoch += RAW_RENDER_EPOCH_INCREMENT;
			entries = new WeakMap();
		},
	});
}

export function attachPtcRenderDispatches(
	details: object,
	dispatches: readonly DispatchProgress[],
): RawRenderStore {
	const store = createRawRenderStore();
	store.attach(details, dispatches, store.begin());
	return store;
}

export function createLiveAttachment(
	dispatch: DispatchProgress,
	isCurrent: () => boolean,
): PtcLiveRenderAttachment {
	const core = isCoreToolName(dispatch.name);
	const liveArguments = getLiveDispatchArguments(dispatch)?.arguments ?? dispatch.args;
	const result = core ? undefined : getLiveDispatchResult(dispatch);
	const args = core ? projectLiveDisplayArguments(dispatch.name, liveArguments) : liveArguments;
	if (core) return { args, hasResult: false, isCurrent };
	let retentionResult: DispatchRenderResult | undefined;
	let projectedResult: unknown;
	try {
		retentionResult = getLiveDispatchRetentionResult(dispatch)?.result ?? dispatch.result;
		projectedResult = result ? result.result : dispatch.result;
	} catch {
		return { args, hasResult: false, isCurrent };
	}
	const displayResult = createLiveDisplayResult(retentionResult);
	return projectedResult === undefined
		? { args, displayResult, hasResult: false, isCurrent }
		: { args, displayResult, hasResult: true, isCurrent, result: projectedResult };
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
