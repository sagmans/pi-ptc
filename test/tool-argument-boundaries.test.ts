import { strict as assert } from "node:assert";
import test from "node:test";

import { Type } from "typebox";
import {
	asSchema,
	createPiToolArgumentPreparer,
	getValidator,
	validatorCache,
} from "../src/pi-runtime-arguments.ts";
import {
	createEntry,
	type HookContext,
	loadNativeValidation,
	TOOL_NAME,
} from "./support/tool-executor-harness.ts";

const NATIVE_ARGUMENT_DIAGNOSTIC_SEPARATOR = "\n\nReceived arguments:";

function nativeToolCall(args: unknown): HookContext["toolCall"] {
	return {
		type: "toolCall",
		id: "native-boundary-validation",
		name: TOOL_NAME,
		arguments: args,
	};
}

test("nested arrays and optional nulls match supported Pi argument preparation", async () => {
	const schema = Type.Object({
		groups: Type.Array(
			Type.Object({
				counts: Type.Array(Type.Integer()),
				note: Type.Optional(Type.String()),
			}),
		),
	});
	const args = {
		groups: [{ counts: ["1", "2"], note: null }, { counts: ["3"] }],
	};
	const entry = createEntry({ parameters: schema });
	const nativeValidation = await loadNativeValidation();
	const native = nativeValidation.validateToolArguments(
		{ name: TOOL_NAME, ...entry.executable },
		nativeToolCall(args),
	);
	const prepared = createPiToolArgumentPreparer(new Map([[TOOL_NAME, entry.executable]]))(
		TOOL_NAME,
		args,
	);

	assert.deepEqual(prepared, { ok: true, value: native });
	assert.deepEqual(args, {
		groups: [{ counts: ["1", "2"], note: null }, { counts: ["3"] }],
	});
});

test("hostile schemas fail closed without exposing received arguments", () => {
	const secret = "hostile-schema-secret";
	const schema = new Proxy(
		{},
		{
			ownKeys() {
				throw new Error("hostile schema");
			},
		},
	);
	const entry = createEntry({ parameters: schema });
	const prepared = createPiToolArgumentPreparer(new Map([[TOOL_NAME, entry.executable]]))(
		TOOL_NAME,
		{ token: secret },
	);

	assert.equal(prepared.ok, false);
	if (prepared.ok) assert.fail("hostile schema must fail");
	assert.equal(prepared.message.includes(secret), false);
	assert.equal(prepared.message.includes(NATIVE_ARGUMENT_DIAGNOSTIC_SEPARATOR), false);
});

test("validator compilation is cached by schema identity", () => {
	const schema = Type.Object({ count: Type.Integer() });
	assert.equal(validatorCache.has(schema), false);
	const first = getValidator(asSchema(schema));
	const second = getValidator(asSchema(schema));
	assert.equal(first, second);
	assert.equal(validatorCache.get(schema), first);
});
