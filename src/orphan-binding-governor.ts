import { SHIPPED_PTC_CONFIG } from "./config.ts";

export type OrphanBindingReservation = {
	release(): void;
};

export type OrphanBindingGovernor = {
	acquire(): OrphanBindingReservation | undefined;
	readonly active: number;
};

export function createOrphanBindingGovernor(limit: number): OrphanBindingGovernor {
	let active = 0;
	return {
		acquire() {
			if (active >= limit) return undefined;
			active += 1;
			let released = false;
			return {
				release() {
					if (released) return;
					released = true;
					active -= 1;
				},
			};
		},
		get active() {
			return active;
		},
	};
}

export const processOrphanBindingGovernor = createOrphanBindingGovernor(
	SHIPPED_PTC_CONFIG.maxOrphanedBindings,
);
