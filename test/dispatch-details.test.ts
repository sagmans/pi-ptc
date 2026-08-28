import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { DispatchRenderResult } from "../src/bridge.ts";
import { SHIPPED_PTC_CONFIG } from "../src/config.ts";
import {
	createDeltaDetails,
	createSnapshotDetails,
	PTC_DETAIL_SCHEMA_VERSION,
	parseDispatchDetails,
	projectDisplayArguments,
	sanitizeDisplayJson,
} from "../src/dispatch-details.ts";
import type { JsonValue } from "../src/json.ts";

const DESCRIPTION = "inspect files";
const LEGACY_DESCRIPTION = "legacy";
const CONTROLLED_COMMAND = "before\u001b[2Jafter";
const SANITIZED_COMMAND = "beforeafter";
const EXTENDED_CONTROLLED_TEXT =
	"before\u001b[?1049hmiddle\u001bc\u0007\u009b31mred\u001bPpayload\u001b\\after";
const EXTENDED_SANITIZED_TEXT = "beforemiddleredafter";
const OVERSIZED_ARGUMENT_TEXT = "argument-data".repeat(100_000);
const OVERSIZED_DESCRIPTION_TAIL = "DESCRIPTION_TAIL_MUST_BE_OMITTED";
const OVERSIZED_ERROR_TAIL = "ERROR_TAIL_MUST_BE_OMITTED";
const COMPATIBILITY_ERROR_MAX_CHARACTERS = 256;
const LONG_EXECUTION_ERROR = "failure ".repeat(COMPATIBILITY_ERROR_MAX_CHARACTERS);
const HOSTILE_DETAILS_ERROR = "hostile details";
const HOSTILE_RESULT_ERROR = "hostile result";
const PROTOTYPE_KEY = "__proto__";
const PROTOTYPE_PATH = "spoofed";
const PROTOTYPE_JSON = `{"${PROTOTYPE_KEY}":{"path":"${PROTOTYPE_PATH}"}}`;
const FULL_RENDER_TEXT = "complete text result";
const FULL_RENDER_DATA = "aW1hZ2UtYnl0ZXM=";
const OMITTED_RENDER_TEXT = "omitted text result";
const OMITTED_RENDER_DATA = "b21pdHRlZC1pbWFnZS1ieXRlcw==";
const FULL_RENDER_RESULT = {
	content: [
		{ type: "text", text: FULL_RENDER_TEXT },
		{ type: "image", data: FULL_RENDER_DATA, mimeType: "image/png" },
	],
	details: { path: "complete.png" },
	isError: false,
} satisfies DispatchRenderResult;
const OMITTED_RENDER_RESULT = {
	content: [
		{ type: "text", text: OMITTED_RENDER_TEXT },
		{ type: "image", data: OMITTED_RENDER_DATA, mimeType: "image/png" },
	],
	details: { path: "omitted.png" },
	isError: false,
} satisfies DispatchRenderResult;
const RENDER_DETAILS_BUDGET_BYTES = Buffer.byteLength(JSON.stringify(FULL_RENDER_RESULT), "utf8");
const PREFLIGHT_RENDER_BUDGET_BYTES = 64;
const OVERSIZED_RENDER_VALUE = "x".repeat(PREFLIGHT_RENDER_BUDGET_BYTES + 1);
const INCOMPATIBLE_RENDER_VALUE = 42;
const CONTROLLED_RESULT_KEY = `key${CONTROLLED_COMMAND}`;
const SANITIZED_RESULT_KEY = `key${SANITIZED_COMMAND}`;
const VERSION_TWO_SUCCESS_FIXTURE = "version-2-success.json";
const VERSION_TWO_ERRORS_FIXTURE = "version-2-errors.json";
const VERSION_TWO_MALFORMED_FIXTURE = "version-2-malformed.json";
const LEGACY_NO_ID_FIXTURE = "legacy-no-id.json";
const GENERIC_TOOL_NAME = "mcp.server/call[odd name]";
const GENERIC_REDACTION_MARKER = "[REDACTED]";
const GENERIC_ARGUMENT_MAX_BYTES = 8192;
const GENERIC_LARGE_VALUE = "GENERIC_PRIVATE_VALUE".repeat(10_000);
const CONTROLLED_TOOL_NAMES = [
	"before\u001b[31mafter",
	"before\u001b]0;unsafe-title\u0007after",
	"before\u001b_payload\u001b\\after",
	"before\nafter",
	"before\u009b31mafter",
] as const;
const COMPOUND_CREDENTIAL_VALUES = [
	"private-access",
	"private-refresh",
	"private-auth",
	"private-bearer",
	"private-session",
] as const;

const START_DISPATCH = {
	id: 2,
	name: "read" as const,
	args: { path: "b" },
	status: "start" as const,
};

function loadDispatchFixture(name: string): unknown {
	return JSON.parse(
		readFileSync(new URL(`fixtures/dispatch-details/${name}`, import.meta.url), "utf8"),
	);
}

const FINAL_DISPATCH = {
	id: 1,
	name: "read" as const,
	args: { path: "a" },
	status: "ok" as const,
	preview: "done",
};

test("display JSON strips terminal sequences recursively", () => {
	assert.deepEqual(sanitizeDisplayJson({ command: CONTROLLED_COMMAND }), {
		command: SANITIZED_COMMAND,
	});
});

test("display JSON strips private-mode, reset, C0, C1, and control-string sequences", () => {
	assert.deepEqual(sanitizeDisplayJson({ command: EXTENDED_CONTROLLED_TEXT }), {
		command: EXTENDED_SANITIZED_TEXT,
	});

	const details = createDeltaDetails(DESCRIPTION, {
		id: 1,
		name: "bash",
		args: { command: EXTENDED_CONTROLLED_TEXT },
		status: "err",
		preview: EXTENDED_CONTROLLED_TEXT,
		result: {
			content: [{ type: "text", text: EXTENDED_CONTROLLED_TEXT }],
			isError: true,
		},
	});
	const serialized = JSON.stringify(details);

	assert.equal(serialized.includes("\\u001b"), false);
	assert.equal(serialized.includes("\\u0007"), false);
	assert.equal(serialized.includes("\\u009b"), false);
	assert.equal(details.dispatches[0]?.preview, EXTENDED_SANITIZED_TEXT);
	assert.equal(details.dispatches[0]?.result?.content[0]?.text, EXTENDED_SANITIZED_TEXT);
});

test("display JSON preserves an own __proto__ key without changing the prototype", () => {
	const sanitized = sanitizeDisplayJson(JSON.parse(PROTOTYPE_JSON));
	const record = sanitized as { [key: string]: unknown };

	assert.equal(Object.getPrototypeOf(sanitized), Object.prototype);
	assert.equal(Object.hasOwn(record, PROTOTYPE_KEY), true);
	assert.deepEqual(record[PROTOTYPE_KEY], { path: PROTOTYPE_PATH });
	assert.equal(record.path, undefined);
});

test("version 2 delta contains one sanitized dispatch", () => {
	assert.deepEqual(
		createDeltaDetails(DESCRIPTION, {
			...START_DISPATCH,
			args: { path: CONTROLLED_COMMAND },
		}),
		{
			schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
			description: DESCRIPTION,
			mode: "delta",
			dispatches: [{ ...START_DISPATCH, args: { path: SANITIZED_COMMAND } }],
		},
	);
});

test("version 2 snapshot orders sanitized dispatches by id", () => {
	assert.deepEqual(createSnapshotDetails(DESCRIPTION, [START_DISPATCH, FINAL_DISPATCH]), {
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description: DESCRIPTION,
		mode: "snapshot",
		dispatches: [FINAL_DISPATCH, START_DISPATCH],
	});
});

test("persisted details bound descriptions, errors, and tool arguments together", () => {
	const oversizedDescription = `${OVERSIZED_ARGUMENT_TEXT}${OVERSIZED_DESCRIPTION_TAIL}`;
	const oversizedError = `${OVERSIZED_ARGUMENT_TEXT}${OVERSIZED_ERROR_TAIL}`;
	const details = createSnapshotDetails(
		oversizedDescription,
		Array.from({ length: 3 }, (_, index) => ({
			id: index + 1,
			name: "write" as const,
			args: { path: `file-${index}.txt`, content: OVERSIZED_ARGUMENT_TEXT },
			status: "ok" as const,
		})),
		oversizedError,
	);
	const serialized = JSON.stringify(details);

	assert.ok(Buffer.byteLength(serialized, "utf8") <= SHIPPED_PTC_CONFIG.maxPersistedDetailsBytes);
	assert.equal(serialized.includes(OVERSIZED_DESCRIPTION_TAIL), false);
	assert.equal(serialized.includes(OVERSIZED_ERROR_TAIL), false);
	assert.equal(serialized.includes(OVERSIZED_ARGUMENT_TEXT), false);
	assert.deepEqual(
		details.dispatches.map((dispatch) => dispatch.args),
		[{ path: "file-0.txt" }, { path: "file-1.txt" }, { path: "file-2.txt" }],
	);
});

test("snapshot render projections omit whole results after the byte budget is exhausted", () => {
	const details = createSnapshotDetails(
		DESCRIPTION,
		[
			{ ...FINAL_DISPATCH, result: FULL_RENDER_RESULT },
			{
				...START_DISPATCH,
				status: "ok",
				preview: "omitted preview",
				result: OMITTED_RENDER_RESULT,
			},
			{
				...START_DISPATCH,
				id: 3,
				status: "ok",
				preview: "later preview",
				result: { content: [], isError: false },
			},
		],
		undefined,
		RENDER_DETAILS_BUDGET_BYTES,
	);

	assert.deepEqual(details.dispatches, [
		{ ...FINAL_DISPATCH, result: FULL_RENDER_RESULT },
		{
			...START_DISPATCH,
			status: "ok",
			preview: "omitted preview",
			renderOmitted: "budget",
		},
		{
			...START_DISPATCH,
			id: 3,
			status: "ok",
			preview: "later preview",
			renderOmitted: "budget",
		},
	]);
	const serialized = JSON.stringify(details);
	assert.equal(serialized.includes(OMITTED_RENDER_TEXT), false);
	assert.equal(serialized.includes(OMITTED_RENDER_DATA), false);
	assert.deepEqual(parseDispatchDetails(JSON.parse(serialized)), details);
});

test("render projection accepts explicit undefined fields and sanitizes controls recursively", () => {
	const details = createDeltaDetails(DESCRIPTION, {
		...FINAL_DISPATCH,
		result: {
			content: [
				{
					type: `text${CONTROLLED_COMMAND}`,
					text: undefined,
					data: undefined,
					mimeType: undefined,
				},
			],
			details: {
				[CONTROLLED_RESULT_KEY]: [CONTROLLED_COMMAND],
			},
			isError: false,
		},
	});

	assert.deepEqual(details.dispatches, [
		{
			...FINAL_DISPATCH,
			result: {
				content: [{ type: `text${SANITIZED_COMMAND}` }],
				details: { [SANITIZED_RESULT_KEY]: [SANITIZED_COMMAND] },
				isError: false,
			},
		},
	]);
	assert.equal(details.compatibilityError, undefined);
});

test("render projection omits only hostile or incompatible results", () => {
	const cyclicDetails: { self?: unknown } = {};
	cyclicDetails.self = cyclicDetails;
	const hostileDetails = new Proxy(
		{},
		{
			ownKeys: () => {
				throw new Error(HOSTILE_DETAILS_ERROR);
			},
		},
	);
	const results = [
		{ content: [], details: cyclicDetails, isError: false },
		{ content: [], details: hostileDetails, isError: false },
		{
			content: [{ type: "text", text: INCOMPATIBLE_RENDER_VALUE }],
			isError: false,
		},
	] as unknown as DispatchRenderResult[];

	for (const result of results) {
		let details: ReturnType<typeof createDeltaDetails> | undefined;
		assert.doesNotThrow(() => {
			details = createDeltaDetails(DESCRIPTION, { ...FINAL_DISPATCH, result });
		});
		assert.deepEqual(details?.dispatches, [{ ...FINAL_DISPATCH, renderOmitted: "incompatible" }]);
		assert.ok((details?.compatibilityError?.length ?? 0) > 0);
		assert.ok((details?.compatibilityError?.length ?? 0) <= COMPATIBILITY_ERROR_MAX_CHARACTERS);
	}
});

test("a hostile live result accessor omits only the render projection", () => {
	const dispatch = Object.defineProperty({ ...FINAL_DISPATCH }, "result", {
		enumerable: true,
		get() {
			throw new Error(HOSTILE_RESULT_ERROR);
		},
	}) as unknown as Parameters<typeof createDeltaDetails>[1];
	let details: ReturnType<typeof createDeltaDetails> | undefined;

	assert.doesNotThrow(() => {
		details = createDeltaDetails(DESCRIPTION, dispatch);
	});
	assert.deepEqual(details?.dispatches, [{ ...FINAL_DISPATCH, renderOmitted: "incompatible" }]);
	assert.ok((details?.compatibilityError?.length ?? 0) > 0);
});

test("a hostile persisted result accessor preserves the base dispatch", () => {
	const dispatch = Object.defineProperty({ ...FINAL_DISPATCH }, "result", {
		enumerable: true,
		get() {
			throw new Error(HOSTILE_RESULT_ERROR);
		},
	});
	const parsed = parseDispatchDetails({
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description: DESCRIPTION,
		mode: "snapshot",
		dispatches: [dispatch],
	});

	assert.deepEqual(parsed.dispatches, [{ ...FINAL_DISPATCH, renderOmitted: "incompatible" }]);
	assert.ok((parsed.compatibilityError?.length ?? 0) > 0);
});

test("oversized render payloads stop before later hostile data is accessed", () => {
	for (const field of ["text", "data"] as const) {
		let detailsReads = 0;
		const result = {
			content: [{ type: field === "text" ? "text" : "image", [field]: OVERSIZED_RENDER_VALUE }],
			get details() {
				detailsReads += 1;
				throw new Error(HOSTILE_DETAILS_ERROR);
			},
			isError: false,
		} as DispatchRenderResult;

		const details = createDeltaDetails(
			DESCRIPTION,
			{ ...FINAL_DISPATCH, result },
			PREFLIGHT_RENDER_BUDGET_BYTES,
		);

		assert.deepEqual(details.dispatches, [{ ...FINAL_DISPATCH, renderOmitted: "budget" }]);
		assert.equal(detailsReads, 0);
	}

	let trailingReads = 0;
	const rawDetails = Object.defineProperties(
		{},
		{
			first: { enumerable: true, value: OVERSIZED_RENDER_VALUE },
			second: {
				enumerable: true,
				get() {
					trailingReads += 1;
					throw new Error(HOSTILE_DETAILS_ERROR);
				},
			},
		},
	);
	const details = createDeltaDetails(
		DESCRIPTION,
		{
			...FINAL_DISPATCH,
			result: { content: [], details: rawDetails, isError: false },
		},
		PREFLIGHT_RENDER_BUDGET_BYTES,
	);

	assert.deepEqual(details.dispatches, [{ ...FINAL_DISPATCH, renderOmitted: "budget" }]);
	assert.equal(trailingReads, 0);
});

test("parsing an incompatible persisted result preserves its base dispatch", () => {
	const parsed = parseDispatchDetails({
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description: DESCRIPTION,
		mode: "snapshot",
		dispatches: [
			{
				...FINAL_DISPATCH,
				result: {
					content: [{ type: "text", text: INCOMPATIBLE_RENDER_VALUE }],
					isError: false,
				},
			},
		],
	});

	assert.deepEqual(parsed.dispatches, [{ ...FINAL_DISPATCH, renderOmitted: "incompatible" }]);
	assert.ok((parsed.compatibilityError?.length ?? 0) > 0);
});

test("legacy adjacent start and final records collapse to one stable id", () => {
	const parsed = parseDispatchDetails({
		description: LEGACY_DESCRIPTION,
		dispatches: [
			{ name: "read", args: { path: "a" }, status: "start" },
			{ name: "read", args: { path: "a" }, status: "ok", preview: "done" },
		],
	});

	assert.deepEqual(parsed, {
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description: LEGACY_DESCRIPTION,
		mode: "snapshot",
		dispatches: [FINAL_DISPATCH],
	});
});

test("version 2 delta rejects dispatch collections without exactly one record", () => {
	for (const dispatches of [[], [FINAL_DISPATCH, START_DISPATCH]]) {
		const parsed = parseDispatchDetails({
			schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
			description: DESCRIPTION,
			mode: "delta",
			dispatches,
		});

		assert.deepEqual(parsed.dispatches, []);
		assert.equal(typeof parsed.compatibilityError, "string");
	}
});

test("version 2 details omit duplicate dispatch ids", () => {
	const parsed = parseDispatchDetails({
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description: DESCRIPTION,
		mode: "snapshot",
		dispatches: [FINAL_DISPATCH, { ...START_DISPATCH, id: FINAL_DISPATCH.id }],
	});

	assert.deepEqual(parsed.dispatches, [FINAL_DISPATCH]);
	assert.equal(typeof parsed.compatibilityError, "string");
});

test("legacy details omit duplicate dispatch ids", () => {
	const parsed = parseDispatchDetails({
		description: LEGACY_DESCRIPTION,
		dispatches: [FINAL_DISPATCH, { ...START_DISPATCH, id: FINAL_DISPATCH.id }],
	});

	assert.deepEqual(parsed.dispatches, [FINAL_DISPATCH]);
	assert.equal(typeof parsed.compatibilityError, "string");
});

test("version 2 details reject dispatch collections over the shipped cap", () => {
	const dispatches = Array.from({ length: SHIPPED_PTC_CONFIG.maxDispatches + 1 }, (_, index) => ({
		...FINAL_DISPATCH,
		id: index + 1,
	}));
	const parsed = parseDispatchDetails({
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description: DESCRIPTION,
		mode: "snapshot",
		dispatches,
	});

	assert.deepEqual(parsed.dispatches, []);
	assert.equal(typeof parsed.compatibilityError, "string");
});

test("legacy details reject dispatch collections over the shipped cap", () => {
	const dispatches = Array.from({ length: SHIPPED_PTC_CONFIG.maxDispatches + 1 }, () => ({
		name: FINAL_DISPATCH.name,
		args: FINAL_DISPATCH.args,
		status: FINAL_DISPATCH.status,
	}));
	const parsed = parseDispatchDetails({ description: LEGACY_DESCRIPTION, dispatches });

	assert.deepEqual(parsed.dispatches, []);
	assert.equal(typeof parsed.compatibilityError, "string");
});

test("malformed dispatch records produce one bounded compatibility diagnostic", () => {
	const parsed = parseDispatchDetails({
		schemaVersion: PTC_DETAIL_SCHEMA_VERSION,
		description: DESCRIPTION,
		mode: "snapshot",
		dispatches: [
			FINAL_DISPATCH,
			{ id: 2, name: "read", args: { path: undefined }, status: "ok" },
			{ id: 3, name: "unknown", args: null, status: "broken" },
		],
	});

	assert.deepEqual(parsed.dispatches, [FINAL_DISPATCH]);
	assert.equal(typeof parsed.compatibilityError, "string");
	assert.ok((parsed.compatibilityError?.length ?? 0) <= COMPATIBILITY_ERROR_MAX_CHARACTERS);
});

test("dispatch detail parsing never throws for hostile input", () => {
	const hostile = new Proxy(
		{},
		{
			has: () => {
				throw new Error(HOSTILE_DETAILS_ERROR);
			},
		},
	);

	assert.doesNotThrow(() => parseDispatchDetails(hostile));
	assert.equal(typeof parseDispatchDetails(hostile).compatibilityError, "string");
});

test("version 2 fixtures preserve native results, omissions, and independent errors", () => {
	const success = parseDispatchDetails(loadDispatchFixture(VERSION_TWO_SUCCESS_FIXTURE));
	const errors = parseDispatchDetails(loadDispatchFixture(VERSION_TWO_ERRORS_FIXTURE));

	const editDetails = success.dispatches[1]?.result?.details;

	assert.equal(success.dispatches.length, 4);
	assert.equal(success.dispatches[0]?.result?.content[0]?.text, "restored read content");
	assert.ok(typeof editDetails === "object" && editDetails !== null && !Array.isArray(editDetails));
	assert.equal(editDetails.diff, "@@ -1 +1 @@\n-old\n+new");
	assert.equal(success.dispatches[2]?.result?.content[1]?.mimeType, "image/png");
	assert.equal(success.dispatches[3]?.renderOmitted, "budget");
	assert.equal(success.dispatches[3]?.preview, "preview-only output");
	assert.equal(errors.dispatches[0]?.status, "err");
	assert.equal(errors.dispatches[0]?.preview, "nested fixture failure");
	assert.equal(errors.executionError, "outer fixture failure");
	assert.deepEqual(parseDispatchDetails(JSON.parse(JSON.stringify(success))), success);
	assert.deepEqual(parseDispatchDetails(JSON.parse(JSON.stringify(errors))), errors);
});

test("historical and malformed fixtures retain deterministic valid rows", () => {
	const legacy = parseDispatchDetails(loadDispatchFixture(LEGACY_NO_ID_FIXTURE));
	const malformed = parseDispatchDetails(loadDispatchFixture(VERSION_TWO_MALFORMED_FIXTURE));

	assert.deepEqual(
		legacy.dispatches.map((dispatch) => ({ id: dispatch.id, name: dispatch.name })),
		[
			{ id: 1, name: "read" },
			{ id: 2, name: "bash" },
		],
	);
	assert.equal(legacy.dispatches[0]?.preview, "legacy restored output");
	assert.equal(typeof legacy.compatibilityError, "string");
	assert.deepEqual(
		malformed.dispatches.map((dispatch) => dispatch.id),
		[1],
	);
	assert.equal(malformed.dispatches[0]?.preview, "valid row survives");
	assert.equal(typeof malformed.compatibilityError, "string");
});

test("version 2 details survive a JSON round-trip", () => {
	const details = createSnapshotDetails(
		DESCRIPTION,
		[START_DISPATCH, FINAL_DISPATCH],
		LONG_EXECUTION_ERROR,
	);
	const restored = parseDispatchDetails(JSON.parse(JSON.stringify(details)));

	assert.deepEqual(restored, details);
});

test("arbitrary exact tool names round-trip through dispatch details", () => {
	const details = createDeltaDetails(DESCRIPTION, {
		id: 7,
		name: GENERIC_TOOL_NAME,
		args: { operation: "status" },
		status: "ok",
		preview: "complete",
	});
	const restored = parseDispatchDetails(JSON.parse(JSON.stringify(details)));

	assert.deepEqual(details.dispatches, [
		{
			id: 7,
			name: GENERIC_TOOL_NAME,
			args: { operation: "status" },
			status: "ok",
			preview: "complete",
		},
	]);
	assert.deepEqual(restored, details);
});

test("controlled exact tool names remain intact in persisted models", () => {
	const details = createSnapshotDetails(
		DESCRIPTION,
		CONTROLLED_TOOL_NAMES.map((name, index) => ({
			id: index + 1,
			name,
			args: {},
			status: "ok" as const,
		})),
	);
	const restored = parseDispatchDetails(JSON.parse(JSON.stringify(details)));

	assert.deepEqual(
		details.dispatches.map(({ name }) => name),
		CONTROLLED_TOOL_NAMES,
	);
	assert.deepEqual(
		restored.dispatches.map(({ name }) => name),
		CONTROLLED_TOOL_NAMES,
	);
});

test("generic display arguments redact normalized credential keys recursively", () => {
	const projected = projectDisplayArguments(GENERIC_TOOL_NAME, {
		Password: "one",
		nested: {
			SECRET: "two",
			token: "three",
			Authorization: "four",
			cookie: "five",
			client_secret: "six",
			OAuthCode: "seven",
			"redirect-url": "eight",
			keep: CONTROLLED_COMMAND,
		},
		array: [{ ClientSecret: "nine" }, { redirect_url: "ten" }],
	});

	assert.deepEqual(projected, {
		Password: GENERIC_REDACTION_MARKER,
		nested: {
			SECRET: GENERIC_REDACTION_MARKER,
			token: GENERIC_REDACTION_MARKER,
			Authorization: GENERIC_REDACTION_MARKER,
			cookie: GENERIC_REDACTION_MARKER,
			client_secret: GENERIC_REDACTION_MARKER,
			OAuthCode: GENERIC_REDACTION_MARKER,
			"redirect-url": GENERIC_REDACTION_MARKER,
			keep: SANITIZED_COMMAND,
		},
		array: [{ ClientSecret: GENERIC_REDACTION_MARKER }, { redirect_url: GENERIC_REDACTION_MARKER }],
	});
});

test("retained generic arguments redact compound credential keys recursively", () => {
	const details = createDeltaDetails(DESCRIPTION, {
		id: 1,
		name: GENERIC_TOOL_NAME,
		args: {
			nested: {
				access_token: COMPOUND_CREDENTIAL_VALUES[0],
				refreshToken: COMPOUND_CREDENTIAL_VALUES[1],
			},
			array: [
				{ authToken: COMPOUND_CREDENTIAL_VALUES[2] },
				{ bearer_token: COMPOUND_CREDENTIAL_VALUES[3] },
				{ session_cookie: COMPOUND_CREDENTIAL_VALUES[4] },
			],
			tokenizer: "keep-tokenizer",
			secretary: "keep-secretary",
		},
		status: "ok",
	});

	assert.deepEqual(details.dispatches[0]?.args, {
		nested: {
			access_token: GENERIC_REDACTION_MARKER,
			refreshToken: GENERIC_REDACTION_MARKER,
		},
		array: [
			{ authToken: GENERIC_REDACTION_MARKER },
			{ bearer_token: GENERIC_REDACTION_MARKER },
			{ session_cookie: GENERIC_REDACTION_MARKER },
		],
		tokenizer: "keep-tokenizer",
		secretary: "keep-secretary",
	});
	const serialized = JSON.stringify(details);
	for (const value of COMPOUND_CREDENTIAL_VALUES) assert.equal(serialized.includes(value), false);
});

test("generic display arguments omit a revoked top-level proxy", () => {
	const { proxy, revoke } = Proxy.revocable({}, {});
	revoke();

	assert.deepEqual(projectDisplayArguments(GENERIC_TOOL_NAME, proxy), {});
});

test("generic display arguments omit a revoked nested object property", () => {
	const { proxy, revoke } = Proxy.revocable({}, {});
	revoke();

	assert.deepEqual(
		projectDisplayArguments(GENERIC_TOOL_NAME, {
			before: "visible before",
			inaccessible: proxy,
			after: "visible after",
		}),
		{
			before: "visible before",
			after: "visible after",
		},
	);
});

test("generic display arguments omit a revoked array entry", () => {
	const { proxy, revoke } = Proxy.revocable({}, {});
	revoke();

	assert.deepEqual(
		projectDisplayArguments(GENERIC_TOOL_NAME, ["visible before", proxy, "visible after"]),
		["visible before", "visible after"],
	);
});

test("generic display arguments stay bounded and tolerate hostile recursive values", () => {
	const cyclic: Record<string, unknown> = {
		large: GENERIC_LARGE_VALUE,
		nested: [{ safe: "yes", password: GENERIC_LARGE_VALUE }],
		nonFinite: Number.POSITIVE_INFINITY,
		negativeZero: -0,
		missing: undefined,
		callable: () => undefined,
		symbol: Symbol("hidden"),
	};
	cyclic.self = cyclic;
	Object.defineProperty(cyclic, "accessor", {
		enumerable: true,
		get() {
			throw new Error(HOSTILE_DETAILS_ERROR);
		},
	});
	cyclic.hostile = new Proxy(
		{},
		{
			ownKeys() {
				throw new Error(HOSTILE_DETAILS_ERROR);
			},
		},
	);

	let projected: JsonValue | undefined;
	assert.doesNotThrow(() => {
		projected = projectDisplayArguments(GENERIC_TOOL_NAME, cyclic);
	});
	const serialized = JSON.stringify(projected);
	assert.ok(Buffer.byteLength(serialized, "utf8") <= GENERIC_ARGUMENT_MAX_BYTES);
	assert.equal(serialized.includes(GENERIC_LARGE_VALUE), false);
	assert.equal(serialized.includes("accessor"), false);
	assert.equal(serialized.includes("private"), false);
});
