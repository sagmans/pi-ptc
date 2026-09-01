import { strict as assert } from "node:assert";
import test from "node:test";

import { ToolCallError, toCanonicalValue, toToolCanonicalValue } from "../src/canonical.ts";

const GENERIC_TOOL_NAME = "mcp.server/call";
const GENERIC_FAILED_MESSAGE = "tool failed";

function createRevokedProxy<T extends object>(target: T): T {
	const revocable = Proxy.revocable(target, {});
	revocable.revoke();
	return revocable.proxy;
}

test("read success omits duplicated truncation content while preserving metadata", () => {
	assert.deepEqual(
		toCanonicalValue("read", {
			content: [{ type: "text", text: "hello\n[Showing lines 1-1 of 2]" }],
			details: {
				encoding: "utf8",
				truncation: {
					content: "hello",
					truncated: true,
					truncatedBy: "bytes",
					totalBytes: 10,
				},
			},
		}),
		{
			text: "hello\n[Showing lines 1-1 of 2]",
			encoding: "utf8",
			truncation: { truncated: true, truncatedBy: "bytes", totalBytes: 10 },
		},
	);
});

test("bash success is output plus exitCode and details", () => {
	assert.deepEqual(
		toCanonicalValue("bash", {
			content: [{ type: "text", text: "ok" }],
			details: { fullOutputPath: "/tmp/out" },
		}),
		{ output: "ok", exitCode: 0, fullOutputPath: "/tmp/out" },
	);
});

test("edit and write success are ok plus details", () => {
	assert.deepEqual(
		toCanonicalValue("edit", {
			content: [{ type: "text", text: "changed" }],
			details: { diff: "-a\n+b" },
		}),
		{ ok: true, diff: "-a\n+b" },
	);
	assert.deepEqual(
		toCanonicalValue("write", {
			content: [{ type: "text", text: "wrote" }],
		}),
		{ ok: true },
	);
});

test("grep find and ls success are text plus details", () => {
	assert.deepEqual(
		toCanonicalValue("grep", {
			content: [{ type: "text", text: "src/a.ts:1:hit" }],
			details: { matchLimitReached: 20 },
		}),
		{ text: "src/a.ts:1:hit", matchLimitReached: 20 },
	);
	assert.deepEqual(
		toCanonicalValue("find", {
			content: [{ type: "text", text: "src/a.ts" }],
			details: { resultLimitReached: 5 },
		}),
		{ text: "src/a.ts", resultLimitReached: 5 },
	);
	assert.deepEqual(
		toCanonicalValue("ls", {
			content: [{ type: "text", text: "src" }],
			details: { entryLimitReached: 3 },
		}),
		{ text: "src", entryLimitReached: 3 },
	);
});

test("generic optional values preserve complete lossless records", () => {
	const shared = { value: 1 };
	const details = JSON.parse('{"__proto__":{"safe":true}}') as Record<string, unknown>;
	details.first = shared;
	details.second = shared;
	const usage = Object.create(null) as Record<string, unknown>;
	usage.total = 3;

	const value = toToolCanonicalValue(
		GENERIC_TOOL_NAME,
		{ content: [], details, usage },
		false,
	) as Record<string, unknown>;
	const projectedDetails = value.details as Record<string, unknown>;

	assert.equal(Object.hasOwn(projectedDetails, "__proto__"), true);
	assert.deepEqual(Reflect.get(projectedDetails, "__proto__"), { safe: true });
	assert.deepEqual(projectedDetails.first, { value: 1 });
	assert.deepEqual(projectedDetails.second, { value: 1 });
	assert.deepEqual(value.usage, { total: 3 });
});

test("generic optional values are omitted unless each complete value is lossless", () => {
	const sparse: unknown[] = [];
	sparse.length = 2;
	sparse[1] = "present";
	const cycle: { self?: unknown } = {};
	cycle.self = cycle;
	for (const details of [new Date(0), new Map([["safe", 1]]), sparse, cycle]) {
		assert.deepEqual(
			toToolCanonicalValue(GENERIC_TOOL_NAME, { content: [], details, usage: { total: 3 } }, false),
			{ text: "", content: [], usage: { total: 3 } },
		);
	}
	assert.deepEqual(
		toToolCanonicalValue(
			GENERIC_TOOL_NAME,
			{ content: [], details: { safe: true }, usage: new Date(0) },
			false,
		),
		{ text: "", content: [], details: { safe: true } },
	);
});

test("revoked result and content proxies use safe success and error fallbacks", () => {
	for (const { result, expected } of [
		{
			result: createRevokedProxy({}),
			expected: { text: "", content: [] },
		},
		{
			result: { content: createRevokedProxy([]), details: { safe: true } },
			expected: { text: "", content: [], details: { safe: true } },
		},
	]) {
		assert.deepEqual(toToolCanonicalValue(GENERIC_TOOL_NAME, result, false), expected);
		assert.throws(
			() => toToolCanonicalValue(GENERIC_TOOL_NAME, result, true),
			(error: unknown) => {
				assert.ok(error instanceof ToolCallError);
				assert.equal(error.message, GENERIC_FAILED_MESSAGE);
				return true;
			},
		);
	}
});

test("revoked content blocks are ignored while valid blocks preserve success and errors", () => {
	const content = [
		{ type: "text", text: "before" },
		createRevokedProxy({}),
		{ type: "text", text: "after" },
	];
	assert.deepEqual(toToolCanonicalValue(GENERIC_TOOL_NAME, { content }, false), {
		text: "beforeafter",
		content: [
			{ type: "text", text: "before" },
			{ type: "text", text: "after" },
		],
	});
	assert.throws(
		() => toToolCanonicalValue(GENERIC_TOOL_NAME, { content }, true),
		(error: unknown) => {
			assert.ok(error instanceof ToolCallError);
			assert.equal(error.message, "beforeafter");
			return true;
		},
	);
});

test("failed factory result rejects as ToolCallError", () => {
	assert.throws(
		() =>
			toCanonicalValue("read", {
				content: [{ type: "text", text: "missing" }],
				isError: true,
			}),
		(error: unknown) => {
			assert.ok(error instanceof ToolCallError);
			assert.equal(error.toolName, "read");
			assert.equal(error.message, "missing");
			return true;
		},
	);
});
