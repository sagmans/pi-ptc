import type { DispatchProgress, DispatchRenderResult, DispatchSummary } from "./bridge.ts";
import {
	type PtcDispatchDetails,
	type PtcDispatchProjection,
	type PtcPersistedDispatch,
	type PtcPersistedRenderResult,
	RENDER_OMITTED_BUDGET,
	RENDER_OMITTED_INCOMPATIBLE,
	type RenderBudget,
	type RenderProjection,
} from "./dispatch-details-model.ts";
import { projectDisplayArguments } from "./display-arguments.ts";
import {
	DISPLAY_PREVIEW_MAX_BYTES,
	sanitizeBoundedDisplayString,
	sanitizeDisplayString,
} from "./display-sanitizer.ts";
import type { JsonValue } from "./json.ts";

const UTF8_ENCODING = "utf8";
const JSON_OBJECT_DELIMITER_BYTES = 1;
const JSON_ARRAY_DELIMITER_BYTES = 1;
const JSON_ENTRY_SEPARATOR_BYTES = 1;
const JSON_NAME_SEPARATOR_BYTES = 1;
const JSON_NULL_BYTES = 4;
const JSON_TRUE_BYTES = 4;
const JSON_FALSE_BYTES = 5;
const RENDER_BUDGET_EXCEEDED = Symbol("render-budget-exceeded");
const RENDER_VALUE_INCOMPATIBLE = Symbol("render-value-incompatible");

export function projectDispatchForRetention(
	dispatch: DispatchProgress,
	maxRenderDetailsBytes: number,
	omitResultForBudget = false,
): PtcDispatchProjection {
	const persisted = sanitizeDispatch(dispatch);
	let result: unknown;
	try {
		result = dispatch.result;
	} catch {
		persisted.renderOmitted = RENDER_OMITTED_INCOMPATIBLE;
		return { dispatch: persisted, renderBytes: 0 };
	}
	if (result === undefined) return { dispatch: persisted, renderBytes: 0 };
	if (omitResultForBudget) {
		persisted.renderOmitted = RENDER_OMITTED_BUDGET;
		return { dispatch: persisted, renderBytes: 0 };
	}
	const projection = projectRenderResult(result, maxRenderDetailsBytes);
	if (projection.kind === "omitted") {
		persisted.renderOmitted = projection.reason;
		return { dispatch: persisted, renderBytes: 0 };
	}
	persisted.result = projection.result;
	return { dispatch: persisted, renderBytes: projection.bytes };
}

function sanitizeDispatch(dispatch: DispatchSummary): PtcPersistedDispatch {
	const sanitized: PtcPersistedDispatch = {
		id: dispatch.id,
		name: dispatch.name,
		args: projectDisplayArguments(dispatch.name, dispatch.args),
		status: dispatch.status,
	};
	if (dispatch.preview !== undefined) {
		sanitized.preview = sanitizeBoundedDisplayString(dispatch.preview, DISPLAY_PREVIEW_MAX_BYTES);
	}
	return sanitized;
}

export function projectRenderResult(
	value: unknown,
	maxRenderDetailsBytes: number,
): RenderProjection {
	const budget: RenderBudget = { remaining: Math.max(0, maxRenderDetailsBytes) };
	const initialBytes = budget.remaining;
	try {
		if (!isUnknownRecord(value)) throw RENDER_VALUE_INCOMPATIBLE;
		const rawContent = value.content;
		const rawIsError = value.isError;
		if (!Array.isArray(rawContent) || typeof rawIsError !== "boolean") {
			throw RENDER_VALUE_INCOMPATIBLE;
		}

		consumeBytes(budget, JSON_OBJECT_DELIMITER_BYTES);
		consumeJsonPropertyName(budget, "content", true);
		consumeBytes(budget, JSON_ARRAY_DELIMITER_BYTES);
		const content: DispatchRenderResult["content"] = [];
		for (const [index, rawBlock] of rawContent.entries()) {
			if (index > 0) consumeBytes(budget, JSON_ENTRY_SEPARATOR_BYTES);
			if (!isUnknownRecord(rawBlock)) throw RENDER_VALUE_INCOMPATIBLE;
			consumeBytes(budget, JSON_OBJECT_DELIMITER_BYTES);
			const block: DispatchRenderResult["content"][number] = {
				type: readRequiredDisplayString(rawBlock, "type", budget, true),
			};
			for (const key of ["text", "data", "mimeType"] as const) {
				const entry = rawBlock[key];
				if (entry === undefined) continue;
				if (typeof entry !== "string") throw RENDER_VALUE_INCOMPATIBLE;
				consumeJsonPropertyName(budget, key, false);
				block[key] = consumeDisplayString(budget, entry);
			}
			consumeBytes(budget, JSON_OBJECT_DELIMITER_BYTES);
			content.push(block);
		}
		consumeBytes(budget, JSON_ARRAY_DELIMITER_BYTES);
		consumeJsonPropertyName(budget, "isError", false);
		consumeBytes(budget, rawIsError ? JSON_TRUE_BYTES : JSON_FALSE_BYTES);

		const result: PtcPersistedRenderResult = { content, isError: rawIsError };
		const rawDetails = value.details;
		if (rawDetails !== undefined) {
			consumeJsonPropertyName(budget, "details", false);
			result.details = cloneBoundedDisplayJson(rawDetails, budget, new WeakSet());
		}
		consumeBytes(budget, JSON_OBJECT_DELIMITER_BYTES);
		return { kind: "accepted", result, bytes: initialBytes - budget.remaining };
	} catch (error) {
		return {
			kind: "omitted",
			reason:
				error === RENDER_BUDGET_EXCEEDED ? RENDER_OMITTED_BUDGET : RENDER_OMITTED_INCOMPATIBLE,
		};
	}
}

function cloneBoundedDisplayJson(
	value: unknown,
	budget: RenderBudget,
	ancestors: WeakSet<object>,
): JsonValue {
	if (value === null) {
		consumeBytes(budget, JSON_NULL_BYTES);
		return null;
	}
	if (typeof value === "string") return consumeDisplayString(budget, value);
	if (typeof value === "boolean") {
		consumeBytes(budget, value ? JSON_TRUE_BYTES : JSON_FALSE_BYTES);
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value) || Object.is(value, -0)) throw RENDER_VALUE_INCOMPATIBLE;
		consumeBytes(budget, Buffer.byteLength(JSON.stringify(value), UTF8_ENCODING));
		return value;
	}
	if (typeof value !== "object") throw RENDER_VALUE_INCOMPATIBLE;
	if (ancestors.has(value)) throw RENDER_VALUE_INCOMPATIBLE;
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			consumeBytes(budget, JSON_ARRAY_DELIMITER_BYTES);
			const result: JsonValue[] = [];
			for (const [index, entry] of value.entries()) {
				if (entry === undefined) throw RENDER_VALUE_INCOMPATIBLE;
				if (index > 0) consumeBytes(budget, JSON_ENTRY_SEPARATOR_BYTES);
				result.push(cloneBoundedDisplayJson(entry, budget, ancestors));
			}
			consumeBytes(budget, JSON_ARRAY_DELIMITER_BYTES);
			return result;
		}

		consumeBytes(budget, JSON_OBJECT_DELIMITER_BYTES);
		const result: { [key: string]: JsonValue } = {};
		let hasEntry = false;
		for (const key of Object.keys(value)) {
			const entry = Reflect.get(value, key);
			if (entry === undefined) continue;
			const sanitizedKey = sanitizeDisplayString(key);
			consumeJsonPropertyName(budget, sanitizedKey, !hasEntry);
			Object.defineProperty(result, sanitizedKey, {
				configurable: true,
				enumerable: true,
				value: cloneBoundedDisplayJson(entry, budget, ancestors),
				writable: true,
			});
			hasEntry = true;
		}
		consumeBytes(budget, JSON_OBJECT_DELIMITER_BYTES);
		return result;
	} finally {
		ancestors.delete(value);
	}
}

function readRequiredDisplayString(
	record: Record<string, unknown>,
	key: string,
	budget: RenderBudget,
	first: boolean,
): string {
	const value = record[key];
	if (typeof value !== "string") throw RENDER_VALUE_INCOMPATIBLE;
	consumeJsonPropertyName(budget, key, first);
	return consumeDisplayString(budget, value);
}

function consumeJsonPropertyName(budget: RenderBudget, name: string, first: boolean): void {
	if (!first) consumeBytes(budget, JSON_ENTRY_SEPARATOR_BYTES);
	consumeJsonString(budget, name);
	consumeBytes(budget, JSON_NAME_SEPARATOR_BYTES);
}

function consumeDisplayString(budget: RenderBudget, value: string): string {
	if (Buffer.byteLength(value, UTF8_ENCODING) + JSON_ARRAY_DELIMITER_BYTES > budget.remaining) {
		throw RENDER_BUDGET_EXCEEDED;
	}
	const sanitized = sanitizeDisplayString(value);
	consumeJsonString(budget, sanitized);
	return sanitized;
}

function consumeJsonString(budget: RenderBudget, value: string): void {
	consumeBytes(budget, Buffer.byteLength(JSON.stringify(value), UTF8_ENCODING));
}

function consumeBytes(budget: RenderBudget, bytes: number): void {
	if (bytes > budget.remaining) throw RENDER_BUDGET_EXCEEDED;
	budget.remaining -= bytes;
}

export function enforcePersistedDetailsBudget(
	details: PtcDispatchDetails,
	maxPersistedDetailsBytes: number,
): PtcDispatchDetails {
	const byteLimit = Math.max(0, maxPersistedDetailsBytes);
	const fits = (): boolean =>
		Buffer.byteLength(JSON.stringify(details), UTF8_ENCODING) <= byteLimit;
	if (fits()) return details;

	for (let index = details.dispatches.length - 1; index >= 0; index -= 1) {
		const dispatch = details.dispatches[index];
		if (!dispatch?.result) continue;
		delete dispatch.result;
		dispatch.renderOmitted = RENDER_OMITTED_BUDGET;
		if (fits()) return details;
	}
	for (let index = details.dispatches.length - 1; index >= 0; index -= 1) {
		const dispatch = details.dispatches[index];
		if (!dispatch || dispatch.preview === undefined) continue;
		delete dispatch.preview;
		if (fits()) return details;
	}
	for (let index = details.dispatches.length - 1; index >= 0; index -= 1) {
		const dispatch = details.dispatches[index];
		if (!dispatch) continue;
		dispatch.args = {};
		if (fits()) return details;
	}
	details.description = "";
	delete details.executionError;
	if (fits()) return details;
	while (details.dispatches.length > 0) {
		details.dispatches.pop();
		if (fits()) return details;
	}
	delete details.compatibilityError;
	return details;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
