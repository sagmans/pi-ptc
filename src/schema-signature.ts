export const SCHEMA_SIGNATURE_MAX_DEPTH = 8;
export const SCHEMA_SIGNATURE_MAX_PROPERTIES = 64;
export const SCHEMA_SIGNATURE_MAX_UNION_MEMBERS = 16;
export const SCHEMA_SIGNATURE_MAX_ENUM_MEMBERS = 32;
export const SCHEMA_SIGNATURE_MAX_OUTPUT_BYTES = 4096;
export const SCHEMA_SIGNATURE_FALLBACK = "Record<string, unknown>";

const ASCII_IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const UNSAFE_JSON_LITERAL_CODE_UNIT_PATTERN =
	/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f]/gu;
const UTF8_ENCODING = "utf8";
const UNSUPPORTED_SCHEMA_KEYS = Object.freeze([
	"$ref",
	"allOf",
	"contains",
	"dependentSchemas",
	"else",
	"if",
	"not",
	"patternProperties",
	"prefixItems",
	"propertyNames",
	"then",
	"unevaluatedItems",
	"unevaluatedProperties",
] as const);
const SUPPORTED_TYPES = new Set([
	"array",
	"boolean",
	"integer",
	"null",
	"number",
	"object",
	"string",
]);

const INVALID_SCHEMA = Symbol("invalid-schema");

type ConversionState = {
	ancestors: WeakSet<object>;
	enumMembers: number;
	properties: number;
	unionMembers: number;
};

type OwnValue = { present: false } | { present: true; value: unknown };

export function renderSafeJsonStringLiteral(value: string): string {
	return JSON.stringify(value).replace(UNSAFE_JSON_LITERAL_CODE_UNIT_PATTERN, (character) => {
		const codeUnit = character.charCodeAt(0).toString(16).padStart(4, "0");
		return `\\u${codeUnit}`;
	});
}

export function schemaToTypeScriptSignature(schema: unknown): string {
	try {
		const signature = renderSchema(schema, 0, {
			ancestors: new WeakSet(),
			enumMembers: 0,
			properties: 0,
			unionMembers: 0,
		});
		return bounded(signature);
	} catch {
		return SCHEMA_SIGNATURE_FALLBACK;
	}
}

function renderSchema(schema: unknown, depth: number, state: ConversionState): string {
	if (depth > SCHEMA_SIGNATURE_MAX_DEPTH || !isObjectRecord(schema)) throw INVALID_SCHEMA;
	if (state.ancestors.has(schema)) throw INVALID_SCHEMA;
	state.ancestors.add(schema);
	try {
		rejectUnsupportedKeywords(schema);
		const constant = ownValue(schema, "const");
		if (constant.present) return renderLiteral(constant.value);
		const enumeration = ownValue(schema, "enum");
		if (enumeration.present) return renderEnum(enumeration.value, state);
		const oneOf = ownValue(schema, "oneOf");
		const anyOf = ownValue(schema, "anyOf");
		if (oneOf.present && anyOf.present) throw INVALID_SCHEMA;
		if (oneOf.present) return renderSchemaUnion(oneOf.value, depth, state);
		if (anyOf.present) return renderSchemaUnion(anyOf.value, depth, state);
		const type = ownValue(schema, "type");
		if (!type.present) throw INVALID_SCHEMA;
		return renderSchemaType(type.value, schema, depth, state);
	} finally {
		state.ancestors.delete(schema);
	}
}

function rejectUnsupportedKeywords(schema: object): void {
	for (const key of UNSUPPORTED_SCHEMA_KEYS) {
		if (ownValue(schema, key).present) throw INVALID_SCHEMA;
	}
}

function renderSchemaUnion(value: unknown, depth: number, state: ConversionState): string {
	const members = readArray(value, SCHEMA_SIGNATURE_MAX_UNION_MEMBERS);
	if (members.length === 0) throw INVALID_SCHEMA;
	state.unionMembers += members.length;
	if (state.unionMembers > SCHEMA_SIGNATURE_MAX_UNION_MEMBERS) throw INVALID_SCHEMA;
	return joinUnion(members.map((member) => renderSchema(member, depth + 1, state)));
}

function renderSchemaType(
	value: unknown,
	schema: object,
	depth: number,
	state: ConversionState,
): string {
	if (typeof value === "string") return renderSingleType(value, schema, depth, state);
	const types = readArray(value, SCHEMA_SIGNATURE_MAX_UNION_MEMBERS);
	if (types.length === 0 || types.some((type) => typeof type !== "string")) throw INVALID_SCHEMA;
	state.unionMembers += types.length;
	if (state.unionMembers > SCHEMA_SIGNATURE_MAX_UNION_MEMBERS) throw INVALID_SCHEMA;
	return joinUnion(types.map((type) => renderSingleType(type as string, schema, depth, state)));
}

function renderSingleType(
	type: string,
	schema: object,
	depth: number,
	state: ConversionState,
): string {
	if (!SUPPORTED_TYPES.has(type)) throw INVALID_SCHEMA;
	switch (type) {
		case "array":
			return renderArray(schema, depth, state);
		case "boolean":
			return "boolean";
		case "integer":
		case "number":
			return "number";
		case "null":
			return "null";
		case "object":
			return renderObject(schema, depth, state);
		case "string":
			return "string";
		default: {
			const _never: never = type as never;
			throw new Error(String(_never));
		}
	}
}

function renderArray(schema: object, depth: number, state: ConversionState): string {
	const items = ownValue(schema, "items");
	if (!items.present) return "unknown[]";
	if (isArray(items.value)) throw INVALID_SCHEMA;
	const item = renderSchema(items.value, depth + 1, state);
	return bounded(`${item.includes(" | ") ? `(${item})` : item}[]`);
}

function renderObject(schema: object, depth: number, state: ConversionState): string {
	const propertiesValue = ownValue(schema, "properties");
	const requiredValue = ownValue(schema, "required");
	const additionalProperties = ownValue(schema, "additionalProperties");
	const properties = propertiesValue.present ? readProperties(propertiesValue.value, state) : [];
	const required = requiredValue.present
		? readRequiredProperties(requiredValue.value)
		: new Set<string>();
	const parts = properties.map(([name, propertySchema]) => {
		const key = ASCII_IDENTIFIER_PATTERN.test(name) ? name : boundedJsonString(name);
		const optional = required.has(name) ? "" : "?";
		return bounded(`${key}${optional}: ${renderSchema(propertySchema, depth + 1, state)}`);
	});
	if (additionalProperties.present) {
		const additional = additionalProperties.value;
		if (additional === true) parts.push("[key: string]: unknown");
		else if (additional !== false) {
			parts.push(bounded(`[key: string]: ${renderSchema(additional, depth + 1, state)}`));
		}
	}
	return bounded(`{${parts.length === 0 ? "" : ` ${parts.join("; ")} `}}`);
}

function readProperties(value: unknown, state: ConversionState): Array<[string, unknown]> {
	if (!isObjectRecord(value)) throw INVALID_SCHEMA;
	let names: string[];
	try {
		names = Object.getOwnPropertyNames(value);
	} catch {
		throw INVALID_SCHEMA;
	}
	const properties: Array<[string, unknown]> = [];
	for (const name of names) {
		const descriptor = ownDescriptor(value, name);
		if (!descriptor.enumerable) continue;
		state.properties += 1;
		if (state.properties > SCHEMA_SIGNATURE_MAX_PROPERTIES) throw INVALID_SCHEMA;
		boundedJsonString(name);
		properties.push([name, descriptor.value]);
	}
	properties.sort(([left], [right]) => compareStrings(left, right));
	return properties;
}

function readRequiredProperties(value: unknown): Set<string> {
	const entries = readArray(value, SCHEMA_SIGNATURE_MAX_PROPERTIES);
	const required = new Set<string>();
	for (const entry of entries) {
		if (typeof entry !== "string") throw INVALID_SCHEMA;
		required.add(entry);
	}
	return required;
}

function renderEnum(value: unknown, state: ConversionState): string {
	const members = readArray(value, SCHEMA_SIGNATURE_MAX_ENUM_MEMBERS);
	if (members.length === 0) throw INVALID_SCHEMA;
	state.enumMembers += members.length;
	if (state.enumMembers > SCHEMA_SIGNATURE_MAX_ENUM_MEMBERS) throw INVALID_SCHEMA;
	return joinUnion(members.map(renderLiteral));
}

function renderLiteral(value: unknown): string {
	if (value === null || typeof value === "boolean") return String(value);
	if (typeof value === "string") return boundedJsonString(value);
	if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) {
		return String(value);
	}
	throw INVALID_SCHEMA;
}

function joinUnion(members: readonly string[]): string {
	const unique = [...new Set(members)].sort(compareStrings);
	if (unique.length === 0) throw INVALID_SCHEMA;
	return bounded(unique.join(" | "));
}

function readArray(value: unknown, maxEntries: number): unknown[] {
	if (!isArray(value)) throw INVALID_SCHEMA;
	const lengthDescriptor = ownDescriptor(value, "length");
	const length = lengthDescriptor.value;
	if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maxEntries) {
		throw INVALID_SCHEMA;
	}
	const entries: unknown[] = [];
	for (let index = 0; index < (length as number); index += 1) {
		entries.push(ownDescriptor(value, String(index)).value);
	}
	return entries;
}

function ownValue(value: object, key: string): OwnValue {
	let descriptor: PropertyDescriptor | undefined;
	try {
		descriptor = Object.getOwnPropertyDescriptor(value, key);
	} catch {
		throw INVALID_SCHEMA;
	}
	if (!descriptor) return { present: false };
	if (!Object.hasOwn(descriptor, "value")) throw INVALID_SCHEMA;
	return { present: true, value: descriptor.value };
}

function ownDescriptor(value: object, key: string): PropertyDescriptor & { value: unknown } {
	const descriptor = ownValue(value, key);
	if (!descriptor.present) throw INVALID_SCHEMA;
	let rawDescriptor: PropertyDescriptor | undefined;
	try {
		rawDescriptor = Object.getOwnPropertyDescriptor(value, key);
	} catch {
		throw INVALID_SCHEMA;
	}
	if (!rawDescriptor || !Object.hasOwn(rawDescriptor, "value")) throw INVALID_SCHEMA;
	return rawDescriptor as PropertyDescriptor & { value: unknown };
}

function boundedJsonString(value: string): string {
	if (Buffer.byteLength(value, UTF8_ENCODING) > SCHEMA_SIGNATURE_MAX_OUTPUT_BYTES) {
		throw INVALID_SCHEMA;
	}
	return bounded(renderSafeJsonStringLiteral(value));
}

function bounded(value: string): string {
	if (Buffer.byteLength(value, UTF8_ENCODING) > SCHEMA_SIGNATURE_MAX_OUTPUT_BYTES) {
		throw INVALID_SCHEMA;
	}
	return value;
}

function compareStrings(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function isObjectRecord(value: unknown): value is object {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
	return !isArray(value);
}

function isArray(value: unknown): value is unknown[] {
	try {
		return Array.isArray(value);
	} catch {
		throw INVALID_SCHEMA;
	}
}
