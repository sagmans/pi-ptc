import { strict as assert } from "node:assert";
import test from "node:test";
import { createToolExecutor } from "../src/tool-executor.ts";
import {
	createEntry,
	createSession,
	immediate,
	type RuntimeEvent,
	resultText,
	TOOL_NAME,
} from "./support/tool-executor-harness.ts";

test("update delivery failures still run after hook and emit one final end", async (t) => {
	const runFailure = async (options: {
		executeError?: Error;
		onUpdate: (partial: unknown) => Promise<void> | void;
		expectedMessage: string;
	}) => {
		let afters = 0;
		const endEvents: RuntimeEvent[] = [];
		const outcome = await createToolExecutor({
			catalog: [
				createEntry({
					async execute(_id, _args, _signal, onUpdate) {
						onUpdate?.({ content: [], details: { accepted: true } });
						if (options.executeError) throw options.executeError;
						return { content: [], details: { executed: true } };
					},
				}),
			],
			session: createSession({
				emit(event) {
					if (event.type === "tool_execution_end") endEvents.push(event);
				},
				afterToolCall(context) {
					afters += 1;
					assert.equal(context.isError, true);
					assert.equal(resultText(context.result ?? {}), options.expectedMessage);
				},
			}),
		}).dispatch({ name: TOOL_NAME, args: {}, onUpdate: options.onUpdate });
		assert.equal(afters, 1);
		assert.equal(endEvents.length, 1);
		assert.equal(endEvents[0]?.result, outcome.result);
		assert.equal(endEvents[0]?.isError, true);
		assert.equal(outcome.isError, true);
		assert.equal(resultText(outcome.result), options.expectedMessage);
	};

	await t.test("synchronous callback throw", async () => {
		await runFailure({
			onUpdate() {
				throw new Error("sync update failed");
			},
			expectedMessage: "sync update failed",
		});
	});

	await t.test("asynchronous callback rejection", async () => {
		await runFailure({
			async onUpdate() {
				await immediate();
				throw new Error("async update failed");
			},
			expectedMessage: "async update failed",
		});
	});

	await t.test("execute error remains primary", async () => {
		await runFailure({
			executeError: new Error("execute failed first"),
			onUpdate() {
				throw new Error("update also failed");
			},
			expectedMessage: "execute failed first",
		});
	});
});
