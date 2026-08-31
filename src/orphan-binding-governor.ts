import { SHIPPED_PTC_CONFIG } from "./config.ts";

const PROCESS_GOVERNOR_SYMBOL_NAME = "pi-ptc.orphan-binding-governor.v1";
const PROCESS_GOVERNOR_KIND = "pi-ptc.orphan-binding-governor-state.v1";

export type OrphanBindingReservation = {
	release(): void;
};

export type OrphanBindingGovernor = {
	acquire(): OrphanBindingReservation | undefined;
	readonly active: number;
};

type ProcessGovernorState = {
	readonly kind: typeof PROCESS_GOVERNOR_KIND;
	active: number;
	limit: number;
};

function isProcessGovernorState(value: unknown): value is ProcessGovernorState {
	if (typeof value !== "object" || value === null) return false;
	const state = value as Partial<ProcessGovernorState>;
	return (
		state.kind === PROCESS_GOVERNOR_KIND &&
		Number.isSafeInteger(state.active) &&
		(state.active ?? -1) >= 0 &&
		Number.isSafeInteger(state.limit) &&
		(state.limit ?? 0) > 0 &&
		(state.active ?? 0) <= (state.limit ?? 0)
	);
}

function governorForState(state: ProcessGovernorState): OrphanBindingGovernor {
	return Object.freeze({
		acquire() {
			if (state.active >= state.limit) return undefined;
			state.active += 1;
			let released = false;
			return Object.freeze({
				release() {
					if (released) return;
					released = true;
					state.active -= 1;
				},
			});
		},
		get active() {
			return state.active;
		},
	});
}

export function createOrphanBindingGovernor(limit: number): OrphanBindingGovernor {
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new RangeError("Orphan binding limit must be a positive safe integer");
	}
	return governorForState({ kind: PROCESS_GOVERNOR_KIND, active: 0, limit });
}

export function resolveProcessOrphanBindingGovernor(
	globalObject: object,
	limit: number,
): OrphanBindingGovernor {
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new RangeError("Orphan binding limit must be a positive safe integer");
	}
	const symbol = Symbol.for(PROCESS_GOVERNOR_SYMBOL_NAME);
	const descriptor = Object.getOwnPropertyDescriptor(globalObject, symbol);
	let state: ProcessGovernorState;
	if (descriptor === undefined) {
		state = { kind: PROCESS_GOVERNOR_KIND, active: 0, limit };
		Object.defineProperty(globalObject, symbol, {
			configurable: false,
			enumerable: false,
			value: state,
			writable: false,
		});
	} else {
		if (!Object.hasOwn(descriptor, "value") || !isProcessGovernorState(descriptor.value)) {
			throw new Error("Stored process orphan binding governor is incompatible");
		}
		state = descriptor.value;
		state.limit = Math.min(state.limit, limit);
	}
	return governorForState(state);
}

export const processOrphanBindingGovernor = resolveProcessOrphanBindingGovernor(
	globalThis,
	SHIPPED_PTC_CONFIG.maxOrphanedBindings,
);
