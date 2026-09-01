import { strict as assert } from "node:assert";
import test from "node:test";

import { createDeltaDetails, projectDisplayArguments } from "../src/dispatch-details.ts";
import type { JsonValue } from "../src/json.ts";
import {
	COMPOUND_CREDENTIAL_VALUES,
	CONTROLLED_COMMAND,
	DESCRIPTION,
	GENERIC_ARGUMENT_MAX_BYTES,
	GENERIC_LARGE_VALUE,
	GENERIC_REDACTION_MARKER,
	GENERIC_TOOL_NAME,
	HOSTILE_DETAILS_ERROR,
	SANITIZED_COMMAND,
} from "./support/dispatch-details-harness.ts";

test("generic display arguments redact normalized credential keys recursively", () => {
	const projected = projectDisplayArguments(GENERIC_TOOL_NAME, {
		Password: "one",
		apiKey: "api",
		private_key: "private",
		credential: "credential",
		passphrase: "passphrase",
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
		apiKey: GENERIC_REDACTION_MARKER,
		private_key: GENERIC_REDACTION_MARKER,
		credential: GENERIC_REDACTION_MARKER,
		passphrase: GENERIC_REDACTION_MARKER,
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
