import type { DispatchStatus, DispatchSummary } from "./bridge.ts";
import { isCoreToolName, SHIPPED_PTC_CONFIG } from "./config.ts";
import {
	compareDispatchIds,
	DELTA_MODE,
	INCOMPATIBLE_DETAILS_MESSAGE,
	type ParsedSummary,
	type ParseState,
	PTC_DETAIL_SCHEMA_VERSION,
	type PtcDispatchDetails,
	type PtcPersistedDispatch,
	type PtcRenderOmission,
	RENDER_OMITTED_BUDGET,
	RENDER_OMITTED_INCOMPATIBLE,
	SNAPSHOT_MODE,
} from "./dispatch-details-model.ts";
import { enforcePersistedDetailsBudget, projectRenderResult } from "./dispatch-retention.ts";
import { projectDisplayArguments } from "./display-arguments.ts";
import {
	boundCompatibilityError,
	DISPLAY_DESCRIPTION_MAX_BYTES,
	DISPLAY_EXECUTION_ERROR_MAX_BYTES,
	DISPLAY_PREVIEW_MAX_BYTES,
	sanitizeBoundedDisplayString,
} from "./display-sanitizer.ts";
import type { JsonValue } from "./json.ts";

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
	const state = createParseState();
	const description = parseDisplayString(value.description, state, "");
	const mode = parseMode(value.mode, state);
	const dispatches = parseVersionTwoDispatches(value.dispatches, mode, state);
	const details: PtcDispatchDetails = {
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description,
		mode,
		dispatches,
	};
	finalizeParsedDetails(value, details, state);
	return enforcePersistedDetailsBudget(details, SHIPPED_PTC_CONFIG.maxPersistedDetailsBytes);
}

function parseLegacyDetails(value: Record<string, unknown>): PtcDispatchDetails {
	const state = createParseState();
	const details: PtcDispatchDetails = {
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description: parseDisplayString(value.description, state, ""),
		mode: SNAPSHOT_MODE,
		dispatches: parseLegacyDispatches(value.dispatches, state),
	};
	finalizeParsedDetails(value, details, state);
	return enforcePersistedDetailsBudget(details, SHIPPED_PTC_CONFIG.maxPersistedDetailsBytes);
}

function createParseState(): ParseState {
	return {
		malformed: false,
		renderBytes: 0,
		renderBudgetExhausted: false,
	};
}

function finalizeParsedDetails(
	source: Record<string, unknown>,
	details: PtcDispatchDetails,
	state: ParseState,
): void {
	copyOptionalDisplayString(source, "executionError", details, state);
	copyOptionalDisplayString(source, "compatibilityError", details, state);
	applyCompatibilityDiagnostic(details, state.malformed);
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
		const parsed = parseDispatchBase(value, requireId);
		if (!parsed) return undefined;
		if (!applyDispatchPreview(value, parsed.dispatch, state)) return undefined;
		if (applyRenderOmission(value, parsed.dispatch, state)) return parsed;
		applyDispatchResult(value, parsed.dispatch, state);
		return parsed;
	} catch {
		return undefined;
	}
}

function parseDispatchBase(
	value: Record<string, unknown>,
	requireId: boolean,
): ParsedSummary | undefined {
	const hasExplicitId = Object.hasOwn(value, "id");
	if (requireId && !hasExplicitId) return undefined;
	const id = hasExplicitId ? value.id : 1;
	if (!isPositiveInteger(id)) return undefined;
	if (typeof value.name !== "string" || !isCoreToolName(value.name)) return undefined;
	if (!isDispatchStatus(value.status)) return undefined;
	if (!hasLosslessArguments(value)) return undefined;
	return {
		dispatch: {
			id,
			name: value.name,
			args: projectDisplayArguments(value.name, value.args),
			status: value.status,
		},
		hasExplicitId,
	};
}

function hasLosslessArguments(value: Record<string, unknown>): boolean {
	return Object.hasOwn(value, "args") && isLosslessJsonValue(value.args, new WeakSet());
}

function isDispatchStatus(value: unknown): value is DispatchStatus {
	return value === "start" || value === "ok" || value === "err";
}

function applyDispatchPreview(
	value: Record<string, unknown>,
	dispatch: PtcPersistedDispatch,
	state: ParseState,
): boolean {
	try {
		const preview = value.preview;
		if (preview === undefined) return true;
		if (typeof preview !== "string") return false;
		dispatch.preview = sanitizeBoundedDisplayString(preview, DISPLAY_PREVIEW_MAX_BYTES);
		return true;
	} catch {
		state.malformed = true;
		return true;
	}
}

function applyRenderOmission(
	value: Record<string, unknown>,
	dispatch: PtcPersistedDispatch,
	state: ParseState,
): boolean {
	let renderOmitted: unknown;
	try {
		renderOmitted = value.renderOmitted;
	} catch {
		dispatch.renderOmitted = RENDER_OMITTED_INCOMPATIBLE;
		state.malformed = true;
		return true;
	}
	if (renderOmitted === undefined) return false;
	if (!isRenderOmission(renderOmitted)) {
		dispatch.renderOmitted = RENDER_OMITTED_INCOMPATIBLE;
		state.malformed = true;
		return true;
	}
	dispatch.renderOmitted = renderOmitted;
	if (renderOmitted === RENDER_OMITTED_BUDGET) state.renderBudgetExhausted = true;
	return true;
}

function isRenderOmission(value: unknown): value is PtcRenderOmission {
	return value === RENDER_OMITTED_BUDGET || value === RENDER_OMITTED_INCOMPATIBLE;
}

function applyDispatchResult(
	value: Record<string, unknown>,
	dispatch: PtcPersistedDispatch,
	state: ParseState,
): void {
	let hasResult: boolean;
	let result: unknown;
	try {
		hasResult = Object.hasOwn(value, "result");
		result = hasResult ? value.result : undefined;
	} catch {
		dispatch.renderOmitted = RENDER_OMITTED_INCOMPATIBLE;
		state.malformed = true;
		return;
	}
	if (!hasResult || result === undefined) return;
	if (state.renderBudgetExhausted) {
		dispatch.renderOmitted = RENDER_OMITTED_BUDGET;
		return;
	}
	const projection = projectRenderResult(
		result,
		Math.max(0, SHIPPED_PTC_CONFIG.maxRenderDetailsBytes - state.renderBytes),
	);
	if (projection.kind === "accepted") {
		dispatch.result = projection.result;
		state.renderBytes += projection.bytes;
		return;
	}
	dispatch.renderOmitted = projection.reason;
	if (projection.reason === RENDER_OMITTED_BUDGET) state.renderBudgetExhausted = true;
	else state.malformed = true;
}

function matchingDispatch(left: DispatchSummary, right: DispatchSummary): boolean {
	return left.name === right.name && JSON.stringify(left.args) === JSON.stringify(right.args);
}

function parseMode(value: unknown, state: ParseState): PtcDispatchDetails["mode"] {
	if (value === DELTA_MODE || value === SNAPSHOT_MODE) return value;
	state.malformed = true;
	return SNAPSHOT_MODE;
}

function parseDisplayString(value: unknown, state: ParseState, fallback: string): string {
	if (typeof value === "string") {
		return sanitizeBoundedDisplayString(value, DISPLAY_DESCRIPTION_MAX_BYTES);
	}
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
	const sanitized = sanitizeBoundedDisplayString(value, DISPLAY_EXECUTION_ERROR_MAX_BYTES);
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
		description: sanitizeBoundedDisplayString(description, DISPLAY_DESCRIPTION_MAX_BYTES),
		mode: SNAPSHOT_MODE,
		dispatches: [],
		compatibilityError: INCOMPATIBLE_DETAILS_MESSAGE,
	};
}

function readDescription(value: Record<string, unknown>): string {
	return typeof value.description === "string" ? value.description : "";
}

function isLosslessJsonValue(value: unknown, ancestors: WeakSet<object>): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
	if (typeof value !== "object" || ancestors.has(value)) return false;
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return value.every((entry) => isLosslessJsonValue(entry, ancestors));
		}
		return Object.keys(value).every((key) =>
			isLosslessJsonValue(Reflect.get(value, key), ancestors),
		);
	} catch {
		return false;
	} finally {
		ancestors.delete(value);
	}
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
