// Exclusive work must drain the pool so file/shell mutations never race a sibling.

const OPERATION_ABORTED_MESSAGE = "Operation aborted";
const NOOP = (): void => undefined;

export type DispatchKind = "parallel" | "exclusive";

export type Scheduler = {
	run<T>(kind: DispatchKind, work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
};

type Waiter = {
	kind: DispatchKind;
	resolve: () => void;
	reject: (error: Error) => void;
	cleanup: () => void;
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
			waiter.cleanup();
			acquire(waiter.kind);
			waiter.resolve();
		}
	};

	return {
		run<T>(kind: DispatchKind, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
			let ready: Promise<void>;
			if (canStart(kind) && waiters.length === 0) {
				acquire(kind);
				ready = Promise.resolve();
			} else {
				ready = new Promise<void>((resolve, reject) => {
					let waiter: Waiter;
					const onAbort = (): void => {
						const index = waiters.indexOf(waiter);
						if (index === -1) return;
						waiters.splice(index, 1);
						waiter.cleanup();
						waiter.reject(new Error(OPERATION_ABORTED_MESSAGE));
						pump();
					};
					waiter = {
						kind,
						resolve,
						reject,
						cleanup: signal ? () => signal.removeEventListener("abort", onAbort) : NOOP,
					};
					waiters.push(waiter);
					signal?.addEventListener("abort", onAbort, { once: true });
					if (signal?.aborted) onAbort();
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
