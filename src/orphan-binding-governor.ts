export type OrphanBindingReservation = {
	release(): void;
};

export type OrphanBindingGovernor = {
	acquire(limit: number): OrphanBindingReservation | undefined;
	readonly active: number;
};

export function createOrphanBindingGovernor(): OrphanBindingGovernor {
	let active = 0;
	return {
		acquire(limit) {
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

export const processOrphanBindingGovernor = createOrphanBindingGovernor();
