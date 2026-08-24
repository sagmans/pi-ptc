// Exclusive work must drain the pool so file/shell mutations never race a sibling.

export type DispatchKind = "parallel" | "exclusive";

export type Scheduler = {
	run<T>(kind: DispatchKind, work: () => Promise<T>): Promise<T>;
};

type Waiter = {
	kind: DispatchKind;
	resolve: () => void;
};

export function createScheduler(maxParallel: number): Scheduler {
	let inFlight = 0;
	let exclusiveHeld = false;
	const waiters: Waiter[] = [];

	const canStart = (kind: DispatchKind): boolean => {
		if (exclusiveHeld) return false;
		if (kind === "exclusive") return inFlight === 0;
		return inFlight < maxParallel;
	};

	const acquire = (kind: DispatchKind): void => {
		if (kind === "exclusive") exclusiveHeld = true;
		inFlight += 1;
	};

	const release = (kind: DispatchKind): void => {
		inFlight -= 1;
		if (kind === "exclusive") exclusiveHeld = false;
	};

	const pump = (): void => {
		while (waiters.length > 0 && canStart(waiters[0].kind)) {
			const waiter = waiters.shift();
			if (!waiter) return;
			acquire(waiter.kind);
			waiter.resolve();
		}
	};

	return {
		run<T>(kind: DispatchKind, work: () => Promise<T>): Promise<T> {
			let ready: Promise<void>;
			if (canStart(kind) && waiters.length === 0) {
				acquire(kind);
				ready = Promise.resolve();
			} else {
				ready = new Promise<void>((resolve) => {
					waiters.push({ kind, resolve });
				});
			}
			return ready.then(async () => {
				try {
					return await work();
				} finally {
					release(kind);
					pump();
				}
			});
		},
	};
}
