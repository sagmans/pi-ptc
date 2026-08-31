import { isCoreToolName } from "./config.ts";
import type { DispatchProgress, DispatchRenderResult } from "./dispatch-contract.ts";
import { projectLiveDisplayArguments } from "./dispatch-details.ts";
import {
	getLiveDispatchArguments,
	getLiveDispatchResult,
	getLiveDispatchRetentionResult,
} from "./dispatch-live.ts";
import { createLiveDisplayResult } from "./renderer.ts";
import type { PtcLiveRenderAttachment } from "./renderer-contract.ts";
import {
	MAX_RENDER_DEFINITION_PROTOTYPE_DEPTH,
	RENDER_DEFINITION_KEYS,
} from "./renderer-definitions.ts";

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

export function readRenderDataValues(
	value: object,
): Partial<Record<(typeof RENDER_DEFINITION_KEYS)[number], unknown>> | undefined {
	const values: Partial<Record<(typeof RENDER_DEFINITION_KEYS)[number], unknown>> = {};
	const unresolved = new Set<string>(RENDER_DEFINITION_KEYS);
	const visited = new Set<object>();
	let current: object | null = value;
	for (let depth = 0; current !== null; depth += 1) {
		if (depth > MAX_RENDER_DEFINITION_PROTOTYPE_DEPTH || visited.has(current)) return undefined;
		visited.add(current);
		for (const key of RENDER_DEFINITION_KEYS) {
			if (!unresolved.has(key)) continue;
			const descriptor = Object.getOwnPropertyDescriptor(current, key);
			if (!descriptor) continue;
			unresolved.delete(key);
			if (Object.hasOwn(descriptor, "value")) values[key] = descriptor.value;
		}
		if (unresolved.size === 0) return values;
		if (depth === MAX_RENDER_DEFINITION_PROTOTYPE_DEPTH) return undefined;
		current = Object.getPrototypeOf(current);
	}
	return values;
}
