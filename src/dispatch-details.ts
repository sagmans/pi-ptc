import { stripTerminalSequences } from "@earendil-works/pi-tui";

import type { DispatchSummary } from "./bridge.ts";
import { isCoreToolName, SHIPPED_PTC_CONFIG } from "./config.ts";
import { type JsonValue, snapshotJsonValue } from "./json.ts";

export const PTC_DETAIL_SCHEMA_VERSION = 2;

const DELTA_MODE = "delta";
const SNAPSHOT_MODE = "snapshot";
const COMPATIBILITY_ERROR_MAX_CHARACTERS = 256;
const INCOMPATIBLE_DETAILS_MESSAGE =
	"Some dispatch display details were omitted because they are incompatible.";

export type PtcDispatchDetails = {
	schemaVersion: 2;
	description: string;
	mode: "delta" | "snapshot";
	dispatches: DispatchSummary[];
	executionError?: string;
	compatibilityError?: string;
};

type ParsedSummary = {
	dispatch: DispatchSummary;
	hasExplicitId: boolean;
};

type ParseState = {
	malformed: boolean;
};

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
	dispatch: DispatchSummary,
): PtcDispatchDetails {
	return {
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description: sanitizeDisplayString(description),
		mode: DELTA_MODE,
		dispatches: [sanitizeDispatch(dispatch)],
	};
}

export function createSnapshotDetails(
	description: string,
	dispatches: readonly DispatchSummary[],
	executionError?: string,
): PtcDispatchDetails {
	const details: PtcDispatchDetails = {
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description: sanitizeDisplayString(description),
		mode: SNAPSHOT_MODE,
		dispatches: dispatches.map(sanitizeDispatch).sort(compareDispatchIds),
	};
	if (executionError !== undefined) {
		details.executionError = sanitizeDisplayString(executionError);
	}
	return details;
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
	const state: ParseState = { malformed: false };
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
	const state: ParseState = { malformed: false };
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
): DispatchSummary[] {
	if (!isBoundedDispatchCollection(value, state)) return [];
	if (mode === DELTA_MODE && value.length !== 1) {
		state.malformed = true;
		return [];
	}

	const dispatches: DispatchSummary[] = [];
	const seenIds = new Set<number>();
	for (const record of value) {
		const parsed = parseDispatch(record, true);
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

function parseLegacyDispatches(value: unknown, state: ParseState): DispatchSummary[] {
	if (!isBoundedDispatchCollection(value, state)) return [];

	const dispatches: DispatchSummary[] = [];
	const seenIds = new Set<number>();
	let nextId = 1;
	let previousWasNoIdStart = false;
	for (const record of value) {
		const parsed = parseDispatch(record, false);
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

function parseDispatch(value: unknown, requireId: boolean): ParsedSummary | undefined {
	let snapshot: JsonValue;
	try {
		snapshot = snapshotJsonValue(value);
	} catch {
		return undefined;
	}
	if (!isJsonRecord(snapshot)) return undefined;

	const hasExplicitId = "id" in snapshot;
	if (requireId && !hasExplicitId) return undefined;
	const id = hasExplicitId ? snapshot.id : 1;
	if (!isPositiveInteger(id)) return undefined;
	if (typeof snapshot.name !== "string" || !isCoreToolName(snapshot.name)) return undefined;
	if (snapshot.status !== "start" && snapshot.status !== "ok" && snapshot.status !== "err") {
		return undefined;
	}
	if (!("args" in snapshot)) return undefined;
	if ("preview" in snapshot && typeof snapshot.preview !== "string") return undefined;

	const dispatch: DispatchSummary = {
		id,
		name: snapshot.name,
		args: sanitizeDisplayJson(snapshot.args),
		status: snapshot.status,
	};
	if (typeof snapshot.preview === "string") {
		dispatch.preview = sanitizeDisplayString(snapshot.preview);
	}
	return { dispatch, hasExplicitId };
}

function sanitizeDispatch(dispatch: DispatchSummary): DispatchSummary {
	const sanitized: DispatchSummary = {
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

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
