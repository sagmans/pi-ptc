import { stripTerminalSequences } from "@earendil-works/pi-tui";

import type { DispatchProgress, DispatchRenderResult, DispatchSummary } from "./bridge.ts";
import { isCoreToolName, SHIPPED_PTC_CONFIG } from "./config.ts";
import { type JsonValue, snapshotJsonValue } from "./json.ts";

export const PTC_DETAIL_SCHEMA_VERSION = 2;

const DELTA_MODE = "delta";
const SNAPSHOT_MODE = "snapshot";
const RENDER_OMITTED_BUDGET = "budget";
const RENDER_OMITTED_INCOMPATIBLE = "incompatible";
const COMPATIBILITY_ERROR_MAX_CHARACTERS = 256;
const INCOMPATIBLE_DETAILS_MESSAGE =
	"Some dispatch display details were omitted because they are incompatible.";
const UTF8_ENCODING = "utf8";
const JSON_OBJECT_DELIMITER_BYTES = 1;
const JSON_ARRAY_DELIMITER_BYTES = 1;
const JSON_ENTRY_SEPARATOR_BYTES = 1;
const JSON_NAME_SEPARATOR_BYTES = 1;
const JSON_NULL_BYTES = 4;
const JSON_TRUE_BYTES = 4;
const JSON_FALSE_BYTES = 5;

export type PtcPersistedRenderResult = Omit<DispatchRenderResult, "details"> & {
	details?: JsonValue;
};

export type PtcRenderOmission = typeof RENDER_OMITTED_BUDGET | typeof RENDER_OMITTED_INCOMPATIBLE;

export type PtcPersistedDispatch = DispatchSummary & {
	result?: PtcPersistedRenderResult;
	renderOmitted?: PtcRenderOmission;
};

export type PtcDispatchProjection = {
	dispatch: PtcPersistedDispatch;
	renderBytes: number;
};

export type PtcDispatchDetails = {
	schemaVersion: 2;
	description: string;
	mode: "delta" | "snapshot";
	dispatches: PtcPersistedDispatch[];
	executionError?: string;
	compatibilityError?: string;
};

type ParsedSummary = {
	dispatch: PtcPersistedDispatch;
	hasExplicitId: boolean;
};

type ParseState = {
	malformed: boolean;
	renderBytes: number;
	renderBudgetExhausted: boolean;
};

type RenderBudget = {
	remaining: number;
};

type RenderProjection =
	| { kind: "accepted"; result: PtcPersistedRenderResult; bytes: number }
	| { kind: "omitted"; reason: PtcRenderOmission };

const RENDER_BUDGET_EXCEEDED = Symbol("render-budget-exceeded");
const RENDER_VALUE_INCOMPATIBLE = Symbol("render-value-incompatible");

export function sanitizeDisplayJson(value: JsonValue): JsonValue {
	if (typeof value === "string") return stripTerminalSequences(value);
	if (Array.isArray(value)) return value.map(sanitizeDisplayJson);
	if (typeof value !== "object" || value === null) return value;

	return Object.fromEntries(
		Object.entries(value).map(
			([key, entry]) => [stripTerminalSequences(key), sanitizeDisplayJson(entry)] as const,
		),
	);
}

export function createDeltaDetails(
	description: string,
	dispatch: DispatchProgress,
	maxRenderDetailsBytes = SHIPPED_PTC_CONFIG.maxRenderDetailsBytes,
): PtcDispatchDetails {
	const projection = projectDispatchForRetention(dispatch, maxRenderDetailsBytes);
	return createDeltaDetailsFromProjection(description, projection.dispatch);
}

export function createDeltaDetailsFromProjection(
	description: string,
	dispatch: PtcPersistedDispatch,
): PtcDispatchDetails {
	return createProjectedDetails(description, DELTA_MODE, [dispatch]);
}

export function createSnapshotDetails(
	description: string,
	dispatches: readonly DispatchProgress[],
	executionError?: string,
	maxRenderDetailsBytes = SHIPPED_PTC_CONFIG.maxRenderDetailsBytes,
): PtcDispatchDetails {
	let retainedRenderBytes = 0;
	let renderBudgetExhausted = false;
	const projected = [...dispatches].sort(compareDispatchIds).map((dispatch) => {
		const projection = projectDispatchForRetention(
			dispatch,
			Math.max(0, maxRenderDetailsBytes - retainedRenderBytes),
			renderBudgetExhausted,
		);
		retainedRenderBytes += projection.renderBytes;
		if (projection.dispatch.renderOmitted === RENDER_OMITTED_BUDGET) {
			renderBudgetExhausted = true;
		}
		return projection.dispatch;
	});
	return createSnapshotDetailsFromProjections(description, projected, executionError);
}

export function createSnapshotDetailsFromProjections(
	description: string,
	dispatches: readonly PtcPersistedDispatch[],
	executionError?: string,
): PtcDispatchDetails {
	return createProjectedDetails(
		description,
		SNAPSHOT_MODE,
		[...dispatches].sort(compareDispatchIds),
		executionError,
	);
}

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

export function parseDispatchDetails(value: unknown): PtcDispatchDetails {
	try {
		return parseDetails(value);
	} catch {
		return incompatibleDetails();
	}
}

function parseDetails(value: unknown): PtcDispatchDetails {
	if (!isUnknownRecord(value)) return incompatibleDetails();
	if ("schemaVersion" in value && value.schemaVersion !== PTC_DETAIL_SCHEMA_VERSION) {
		return incompatibleDetails(readDescription(value));
	}
	return value.schemaVersion === PTC_DETAIL_SCHEMA_VERSION
		? parseVersionTwoDetails(value)
		: parseLegacyDetails(value);
}

function parseVersionTwoDetails(value: Record<string, unknown>): PtcDispatchDetails {
	const state: ParseState = {
		malformed: false,
		renderBytes: 0,
		renderBudgetExhausted: false,
	};
	const description = parseDisplayString(value.description, state, "");
	const mode = parseMode(value.mode, state);
	const dispatches = parseVersionTwoDispatches(value.dispatches, mode, state);
	const details: PtcDispatchDetails = {
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description,
		mode,
		dispatches,
	};
	copyOptionalDisplayString(value, "executionError", details, state);
	copyOptionalDisplayString(value, "compatibilityError", details, state);
	applyCompatibilityDiagnostic(details, state.malformed);
	return details;
}

function parseLegacyDetails(value: Record<string, unknown>): PtcDispatchDetails {
	const state: ParseState = {
		malformed: false,
		renderBytes: 0,
		renderBudgetExhausted: false,
	};
	const details: PtcDispatchDetails = {
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description: parseDisplayString(value.description, state, ""),
		mode: SNAPSHOT_MODE,
		dispatches: parseLegacyDispatches(value.dispatches, state),
	};
	copyOptionalDisplayString(value, "executionError", details, state);
	copyOptionalDisplayString(value, "compatibilityError", details, state);
	applyCompatibilityDiagnostic(details, state.malformed);
	return details;
}

function parseVersionTwoDispatches(
	value: unknown,
	mode: PtcDispatchDetails["mode"],
	state: ParseState,
): PtcPersistedDispatch[] {
	if (!isBoundedDispatchCollection(value, state)) return [];
	if (mode === DELTA_MODE && value.length !== 1) {
		state.malformed = true;
		return [];
	}

	const dispatches: PtcPersistedDispatch[] = [];
	const seenIds = new Set<number>();
	for (const record of value) {
		const parsed = parseDispatch(record, true, state);
		if (!parsed) {
			state.malformed = true;
			continue;
		}
		if (seenIds.has(parsed.dispatch.id)) {
			state.malformed = true;
			continue;
		}
		seenIds.add(parsed.dispatch.id);
		dispatches.push(parsed.dispatch);
	}
	return dispatches.sort(compareDispatchIds);
}

function parseLegacyDispatches(value: unknown, state: ParseState): PtcPersistedDispatch[] {
	if (!isBoundedDispatchCollection(value, state)) return [];

	const dispatches: PtcPersistedDispatch[] = [];
	const seenIds = new Set<number>();
	let nextId = 1;
	let previousWasNoIdStart = false;
	for (const record of value) {
		const parsed = parseDispatch(record, false, state);
		if (!parsed) {
			state.malformed = true;
			previousWasNoIdStart = false;
			continue;
		}

		if (parsed.hasExplicitId) {
			if (seenIds.has(parsed.dispatch.id)) {
				state.malformed = true;
				previousWasNoIdStart = false;
				continue;
			}
			seenIds.add(parsed.dispatch.id);
			dispatches.push(parsed.dispatch);
			nextId = Math.max(nextId, parsed.dispatch.id + 1);
			previousWasNoIdStart = false;
			continue;
		}

		const previous = dispatches.at(-1);
		if (
			previousWasNoIdStart &&
			previous?.status === "start" &&
			parsed.dispatch.status !== "start" &&
			matchingDispatch(previous, parsed.dispatch)
		) {
			dispatches[dispatches.length - 1] = { ...parsed.dispatch, id: previous.id };
			previousWasNoIdStart = false;
			continue;
		}

		dispatches.push({ ...parsed.dispatch, id: nextId });
		seenIds.add(nextId);
		nextId += 1;
		previousWasNoIdStart = parsed.dispatch.status === "start";
	}
	return dispatches.sort(compareDispatchIds);
}

function isBoundedDispatchCollection(value: unknown, state: ParseState): value is unknown[] {
	if (!Array.isArray(value) || value.length > SHIPPED_PTC_CONFIG.maxDispatches) {
		state.malformed = true;
		return false;
	}
	return true;
}

function parseDispatch(
	value: unknown,
	requireId: boolean,
	state: ParseState,
): ParsedSummary | undefined {
	try {
		if (!isUnknownRecord(value)) return undefined;
		const hasExplicitId = Object.hasOwn(value, "id");
		if (requireId && !hasExplicitId) return undefined;
		const id = hasExplicitId ? value.id : 1;
		if (!isPositiveInteger(id)) return undefined;
		if (typeof value.name !== "string" || !isCoreToolName(value.name)) return undefined;
		if (value.status !== "start" && value.status !== "ok" && value.status !== "err") {
			return undefined;
		}
		if (!Object.hasOwn(value, "args")) return undefined;
		const args = sanitizeDisplayJson(snapshotJsonValue(value.args));
		const dispatch: PtcPersistedDispatch = {
			id,
			name: value.name,
			args,
			status: value.status,
		};
		try {
			const preview = value.preview;
			if (preview !== undefined) {
				if (typeof preview !== "string") return undefined;
				dispatch.preview = sanitizeDisplayString(preview);
			}
		} catch {
			state.malformed = true;
		}

		let renderOmitted: unknown;
		try {
			renderOmitted = value.renderOmitted;
		} catch {
			dispatch.renderOmitted = RENDER_OMITTED_INCOMPATIBLE;
			state.malformed = true;
			return { dispatch, hasExplicitId };
		}
		if (renderOmitted !== undefined) {
			if (
				renderOmitted !== RENDER_OMITTED_BUDGET &&
				renderOmitted !== RENDER_OMITTED_INCOMPATIBLE
			) {
				dispatch.renderOmitted = RENDER_OMITTED_INCOMPATIBLE;
				state.malformed = true;
				return { dispatch, hasExplicitId };
			}
			dispatch.renderOmitted = renderOmitted;
			if (renderOmitted === RENDER_OMITTED_BUDGET) {
				state.renderBudgetExhausted = true;
			}
			return { dispatch, hasExplicitId };
		}

		let hasResult: boolean;
		let result: unknown;
		try {
			hasResult = Object.hasOwn(value, "result");
			result = hasResult ? value.result : undefined;
		} catch {
			dispatch.renderOmitted = RENDER_OMITTED_INCOMPATIBLE;
			state.malformed = true;
			return { dispatch, hasExplicitId };
		}
		if (!hasResult || result === undefined) return { dispatch, hasExplicitId };
		if (state.renderBudgetExhausted) {
			dispatch.renderOmitted = RENDER_OMITTED_BUDGET;
			return { dispatch, hasExplicitId };
		}
		const projection = projectRenderResult(
			result,
			Math.max(0, SHIPPED_PTC_CONFIG.maxRenderDetailsBytes - state.renderBytes),
		);
		if (projection.kind === "omitted") {
			dispatch.renderOmitted = projection.reason;
			if (projection.reason === RENDER_OMITTED_BUDGET) {
				state.renderBudgetExhausted = true;
			} else {
				state.malformed = true;
			}
			return { dispatch, hasExplicitId };
		}
		dispatch.result = projection.result;
		state.renderBytes += projection.bytes;
		return { dispatch, hasExplicitId };
	} catch {
		return undefined;
	}
}

function createProjectedDetails(
	description: string,
	mode: PtcDispatchDetails["mode"],
	dispatches: PtcPersistedDispatch[],
	executionError?: string,
): PtcDispatchDetails {
	const details: PtcDispatchDetails = {
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description: sanitizeDisplayString(description),
		mode,
		dispatches,
	};
	if (executionError !== undefined) {
		details.executionError = sanitizeDisplayString(executionError);
	}
	if (dispatches.some((dispatch) => dispatch.renderOmitted === RENDER_OMITTED_INCOMPATIBLE)) {
		details.compatibilityError = INCOMPATIBLE_DETAILS_MESSAGE;
	}
	return details;
}

function sanitizeDispatch(dispatch: DispatchSummary): PtcPersistedDispatch {
	const sanitized: PtcPersistedDispatch = {
		id: dispatch.id,
		name: dispatch.name,
		args: sanitizeDisplayJson(dispatch.args),
		status: dispatch.status,
	};
	if (dispatch.preview !== undefined) {
		sanitized.preview = sanitizeDisplayString(dispatch.preview);
	}
	return sanitized;
}

function projectRenderResult(value: unknown, maxRenderDetailsBytes: number): RenderProjection {
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

function matchingDispatch(left: DispatchSummary, right: DispatchSummary): boolean {
	return left.name === right.name && JSON.stringify(left.args) === JSON.stringify(right.args);
}

function compareDispatchIds(left: DispatchSummary, right: DispatchSummary): number {
	return left.id - right.id;
}

function parseMode(value: unknown, state: ParseState): PtcDispatchDetails["mode"] {
	if (value === DELTA_MODE || value === SNAPSHOT_MODE) return value;
	state.malformed = true;
	return SNAPSHOT_MODE;
}

function parseDisplayString(value: unknown, state: ParseState, fallback: string): string {
	if (typeof value === "string") return sanitizeDisplayString(value);
	state.malformed = true;
	return fallback;
}

function copyOptionalDisplayString(
	source: Record<string, unknown>,
	key: "executionError" | "compatibilityError",
	target: PtcDispatchDetails,
	state: ParseState,
): void {
	if (!(key in source)) return;
	const value = source[key];
	if (typeof value !== "string") {
		state.malformed = true;
		return;
	}
	const sanitized = sanitizeDisplayString(value);
	target[key] = key === "compatibilityError" ? boundCompatibilityError(sanitized) : sanitized;
}

function applyCompatibilityDiagnostic(details: PtcDispatchDetails, malformed: boolean): void {
	if (!malformed) return;
	const combined = details.compatibilityError
		? `${details.compatibilityError} ${INCOMPATIBLE_DETAILS_MESSAGE}`
		: INCOMPATIBLE_DETAILS_MESSAGE;
	details.compatibilityError = boundCompatibilityError(combined);
}

function incompatibleDetails(description = ""): PtcDispatchDetails {
	return {
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description: sanitizeDisplayString(description),
		mode: SNAPSHOT_MODE,
		dispatches: [],
		compatibilityError: INCOMPATIBLE_DETAILS_MESSAGE,
	};
}

function readDescription(value: Record<string, unknown>): string {
	return typeof value.description === "string" ? value.description : "";
}

function sanitizeDisplayString(value: string): string {
	return stripTerminalSequences(value);
}

function boundCompatibilityError(value: string): string {
	return value.slice(0, COMPATIBILITY_ERROR_MAX_CHARACTERS);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
