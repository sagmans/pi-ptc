import type { DispatchRenderResult, DispatchSummary } from "./dispatch-contract.ts";
import type { JsonValue } from "./json.ts";

export const PTC_DETAIL_SCHEMA_VERSION = 2;
export const DELTA_MODE = "delta";
export const SNAPSHOT_MODE = "snapshot";
export const RENDER_OMITTED_BUDGET = "budget";
export const RENDER_OMITTED_INCOMPATIBLE = "incompatible";
export const INCOMPATIBLE_DETAILS_MESSAGE =
	"Some dispatch display details were omitted because they are incompatible.";

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

export type ParsedSummary = {
	dispatch: PtcPersistedDispatch;
	hasExplicitId: boolean;
};

export type ParseState = {
	malformed: boolean;
	renderBytes: number;
	renderBudgetExhausted: boolean;
};

export type RenderBudget = {
	remaining: number;
};

export type RenderProjection =
	| { kind: "accepted"; result: PtcPersistedRenderResult; bytes: number }
	| { kind: "omitted"; reason: PtcRenderOmission };

export function compareDispatchIds(left: DispatchSummary, right: DispatchSummary): number {
	return left.id - right.id;
}
