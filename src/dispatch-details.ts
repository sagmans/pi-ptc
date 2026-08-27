import type { DispatchProgress } from "./bridge.ts";
import { SHIPPED_PTC_CONFIG } from "./config.ts";
import {
	compareDispatchIds,
	DELTA_MODE,
	INCOMPATIBLE_DETAILS_MESSAGE,
	PTC_DETAIL_SCHEMA_VERSION,
	type PtcDispatchDetails,
	type PtcPersistedDispatch,
	RENDER_OMITTED_BUDGET,
	RENDER_OMITTED_INCOMPATIBLE,
	SNAPSHOT_MODE,
} from "./dispatch-details-model.ts";
import {
	enforcePersistedDetailsBudget,
	projectDispatchForRetention,
} from "./dispatch-retention.ts";
import {
	DISPLAY_DESCRIPTION_MAX_BYTES,
	DISPLAY_EXECUTION_ERROR_MAX_BYTES,
	sanitizeBoundedDisplayString,
} from "./display-sanitizer.ts";

export {
	PTC_DETAIL_SCHEMA_VERSION,
	type PtcDispatchDetails,
	type PtcDispatchProjection,
	type PtcPersistedDispatch,
	type PtcPersistedRenderResult,
	type PtcRenderOmission,
} from "./dispatch-details-model.ts";
export { parseDispatchDetails } from "./dispatch-details-parser.ts";
export { projectDispatchForRetention } from "./dispatch-retention.ts";
export { projectDisplayArguments, projectLiveDisplayArguments } from "./display-arguments.ts";
export { sanitizeDisplayJson, sanitizeDisplayText } from "./display-sanitizer.ts";

export function createDeltaDetails(
	description: string,
	dispatch: DispatchProgress,
	maxRenderDetailsBytes = SHIPPED_PTC_CONFIG.maxRenderDetailsBytes,
	maxPersistedDetailsBytes = SHIPPED_PTC_CONFIG.maxPersistedDetailsBytes,
): PtcDispatchDetails {
	const projection = projectDispatchForRetention(dispatch, maxRenderDetailsBytes);
	return createDeltaDetailsFromProjection(
		description,
		projection.dispatch,
		maxPersistedDetailsBytes,
	);
}

export function createDeltaDetailsFromProjection(
	description: string,
	dispatch: PtcPersistedDispatch,
	maxPersistedDetailsBytes = SHIPPED_PTC_CONFIG.maxPersistedDetailsBytes,
): PtcDispatchDetails {
	return createProjectedDetails(
		description,
		DELTA_MODE,
		[dispatch],
		undefined,
		maxPersistedDetailsBytes,
	);
}

export function createSnapshotDetails(
	description: string,
	dispatches: readonly DispatchProgress[],
	executionError?: string,
	maxRenderDetailsBytes = SHIPPED_PTC_CONFIG.maxRenderDetailsBytes,
	maxPersistedDetailsBytes = SHIPPED_PTC_CONFIG.maxPersistedDetailsBytes,
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
	return createSnapshotDetailsFromProjections(
		description,
		projected,
		executionError,
		maxPersistedDetailsBytes,
	);
}

export function createSnapshotDetailsFromProjections(
	description: string,
	dispatches: readonly PtcPersistedDispatch[],
	executionError?: string,
	maxPersistedDetailsBytes = SHIPPED_PTC_CONFIG.maxPersistedDetailsBytes,
): PtcDispatchDetails {
	return createProjectedDetails(
		description,
		SNAPSHOT_MODE,
		[...dispatches].sort(compareDispatchIds),
		executionError,
		maxPersistedDetailsBytes,
	);
}

function createProjectedDetails(
	description: string,
	mode: PtcDispatchDetails["mode"],
	dispatches: PtcPersistedDispatch[],
	executionError: string | undefined,
	maxPersistedDetailsBytes: number,
): PtcDispatchDetails {
	const details: PtcDispatchDetails = {
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description: sanitizeBoundedDisplayString(description, DISPLAY_DESCRIPTION_MAX_BYTES),
		mode,
		dispatches: dispatches.map((dispatch) => ({ ...dispatch })),
	};
	if (executionError !== undefined) {
		details.executionError = sanitizeBoundedDisplayString(
			executionError,
			DISPLAY_EXECUTION_ERROR_MAX_BYTES,
		);
	}
	if (dispatches.some((dispatch) => dispatch.renderOmitted === RENDER_OMITTED_INCOMPATIBLE)) {
		details.compatibilityError = INCOMPATIBLE_DETAILS_MESSAGE;
	}
	return enforcePersistedDetailsBudget(details, maxPersistedDetailsBytes);
}
