import { strict as assert } from "node:assert";
import test from "node:test";

import { createScheduler } from "../src/scheduler.ts";

const OPERATION_ABORTED_MESSAGE = "Operation aborted";

function deferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

test("parallel dispatches start in submission order and may overlap", async () => {
	const scheduler = createScheduler(2);
	const started: string[] = [];
	const first = deferred();
	const second = deferred();

	const a = scheduler.run("parallel", async () => {
		started.push("a");
		await first.promise;
		return "a";
	});
	const b = scheduler.run("parallel", async () => {
		started.push("b");
		await second.promise;
		return "b";
	});

	await Promise.resolve();
	assert.deepEqual(started, ["a", "b"]);
	first.resolve();
	second.resolve();
	assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
});

test("parallel dispatches never exceed the pool cap", async () => {
	const scheduler = createScheduler(2);
	let inFlight = 0;
	let peak = 0;
	const gates = [deferred(), deferred(), deferred()];

	const jobs = gates.map((gate) =>
		scheduler.run("parallel", async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await gate.promise;
			inFlight -= 1;
		}),
	);

	await Promise.resolve();
	assert.equal(peak, 2);
	assert.equal(inFlight, 2);
	gates[0].resolve();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(peak, 2);
	gates[1].resolve();
	gates[2].resolve();
	await Promise.all(jobs);
});

test("exclusive dispatch waits for the pool to drain and runs alone", async () => {
	const scheduler = createScheduler(2);
	const started: string[] = [];
	const parallelGate = deferred();
	const exclusiveGate = deferred();

	const parallel = scheduler.run("parallel", async () => {
		started.push("parallel");
		await parallelGate.promise;
	});
	const exclusive = scheduler.run("exclusive", async () => {
		started.push("exclusive");
		await exclusiveGate.promise;
	});
	const later = scheduler.run("parallel", async () => {
		started.push("later");
	});

	await Promise.resolve();
	assert.deepEqual(started, ["parallel"]);
	parallelGate.resolve();
	await parallel;
	await Promise.resolve();
	assert.deepEqual(started, ["parallel", "exclusive"]);
	exclusiveGate.resolve();
	await exclusive;
	await later;
	assert.deepEqual(started, ["parallel", "exclusive", "later"]);
});

test("aborting a queued waiter rejects immediately and preserves surviving FIFO", async () => {
	const scheduler = createScheduler(1);
	const blockerGate = deferred();
	const firstGate = deferred();
	const controller = new AbortController();
	const started: string[] = [];

	const blocker = scheduler.run("exclusive", async () => {
		started.push("blocker");
		await blockerGate.promise;
	});
	await Promise.resolve();
	const first = scheduler.run("parallel", async () => {
		started.push("first");
		await firstGate.promise;
	});
	const aborted = scheduler.run(
		"parallel",
		async () => {
			started.push("aborted");
		},
		controller.signal,
	);
	const last = scheduler.run("parallel", async () => {
		started.push("last");
	});

	controller.abort();
	await assert.rejects(aborted, {
		name: "Error",
		message: OPERATION_ABORTED_MESSAGE,
	});
	assert.deepEqual(started, ["blocker"]);

	blockerGate.resolve();
	await blocker;
	await Promise.resolve();
	assert.deepEqual(started, ["blocker", "first"]);

	firstGate.resolve();
	await first;
	await last;
	assert.deepEqual(started, ["blocker", "first", "last"]);

	await scheduler.run("parallel", async () => {
		started.push("reused");
	});
	assert.deepEqual(started, ["blocker", "first", "last", "reused"]);
});

test("removing an aborted queue head pumps the next compatible waiter", async () => {
	const scheduler = createScheduler(2);
	const heldGate = deferred();
	const controller = new AbortController();
	let exclusiveStarted = false;
	let survivorStarted = false;

	const held = scheduler.run("parallel", async () => {
		await heldGate.promise;
	});
	await Promise.resolve();
	const abortedExclusive = scheduler.run(
		"exclusive",
		async () => {
			exclusiveStarted = true;
		},
		controller.signal,
	);
	const survivor = scheduler.run("parallel", async () => {
		survivorStarted = true;
	});
	await Promise.resolve();
	assert.equal(survivorStarted, false);

	controller.abort();
	await assert.rejects(abortedExclusive, {
		name: "Error",
		message: OPERATION_ABORTED_MESSAGE,
	});
	await Promise.resolve();
	assert.equal(exclusiveStarted, false);
	assert.equal(survivorStarted, true);

	heldGate.resolve();
	await Promise.all([held, survivor]);
});

test("two exclusive dispatches never overlap", async () => {
	const scheduler = createScheduler(2);
	let inFlight = 0;
	let peak = 0;
	const first = deferred();

	const a = scheduler.run("exclusive", async () => {
		inFlight += 1;
		peak = Math.max(peak, inFlight);
		await first.promise;
		inFlight -= 1;
	});
	const b = scheduler.run("exclusive", async () => {
		inFlight += 1;
		peak = Math.max(peak, inFlight);
		inFlight -= 1;
	});

	await Promise.resolve();
	assert.equal(inFlight, 1);
	first.resolve();
	await Promise.all([a, b]);
	assert.equal(peak, 1);
});
