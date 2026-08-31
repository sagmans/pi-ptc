import type { TSchema } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import { Value } from "typebox/value";
import type { PiRuntimeTool, PiToolArgumentPreparation } from "./pi-runtime-contract.ts";

export const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

export const validatorCache = new WeakMap<object, Validator>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

export type SchemaRecord = TSchema & Record<string, unknown>;

export function asSchema(value: unknown): SchemaRecord {
	return value as SchemaRecord;
}

export function schemaProperties(schema: SchemaRecord): Record<string, SchemaRecord> | undefined {
	return isRecord(schema.properties)
		? (schema.properties as Record<string, SchemaRecord>)
		: undefined;
}

export function getSchemaTypes(schema: SchemaRecord): string[] {
	if (typeof schema.type === "string") return [schema.type];
	if (Array.isArray(schema.type)) {
		return schema.type.filter((type): type is string => typeof type === "string");
	}
	return [];
}

export function matchesJsonType(value: unknown, type: string): boolean {
	switch (type) {
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "string":
			return typeof value === "string";
		case "null":
			return value === null;
		case "array":
			return Array.isArray(value);
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		default:
			return false;
	}
}

export function getValidator(schema: SchemaRecord): Validator {
	const cached = validatorCache.get(schema);
	if (cached) return cached;
	const validator = Compile(schema);
	validatorCache.set(schema, validator);
	return validator;
}

export function getSubSchemaValidator(schema: unknown): Validator | undefined {
	if (!isRecord(schema)) return undefined;
	try {
		return getValidator(asSchema(schema));
	} catch {
		return undefined;
	}
}

export function coercePrimitiveByType(value: unknown, type: string): unknown {
	switch (type) {
		case "number": {
			if (value === null) return 0;
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (Number.isFinite(parsed)) return parsed;
			}
			if (typeof value === "boolean") return value ? 1 : 0;
			return value;
		}
		case "integer": {
			if (value === null) return 0;
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (Number.isInteger(parsed)) return parsed;
			}
			if (typeof value === "boolean") return value ? 1 : 0;
			return value;
		}
		case "boolean": {
			if (value === null) return false;
			if (typeof value === "string") {
				if (value === "true") return true;
				if (value === "false") return false;
			}
			if (typeof value === "number") {
				if (value === 1) return true;
				if (value === 0) return false;
			}
			return value;
		}
		case "string":
			if (value === null) return "";
			return typeof value === "number" || typeof value === "boolean" ? String(value) : value;
		case "null":
			return value === "" || value === 0 || value === false ? null : value;
		default:
			return value;
	}
}

export function applySchemaObjectCoercion(
	value: Record<string, unknown>,
	schema: SchemaRecord,
): void {
	const properties = schemaProperties(schema);
	const definedKeys = new Set(properties ? Object.keys(properties) : []);
	if (properties) {
		for (const [key, propertySchema] of Object.entries(properties)) {
			if (!(key in value)) continue;
			value[key] = coerceWithJsonSchema(value[key], propertySchema);
		}
	}
	if (isRecord(schema.additionalProperties)) {
		for (const [key, propertyValue] of Object.entries(value)) {
			if (definedKeys.has(key)) continue;
			value[key] = coerceWithJsonSchema(propertyValue, asSchema(schema.additionalProperties));
		}
	}
}

export function applySchemaArrayCoercion(value: unknown[], schema: SchemaRecord): void {
	if (Array.isArray(schema.items)) {
		for (let index = 0; index < value.length; index += 1) {
			const itemSchema = schema.items[index];
			if (!isRecord(itemSchema)) continue;
			value[index] = coerceWithJsonSchema(value[index], asSchema(itemSchema));
		}
		return;
	}
	if (isRecord(schema.items)) {
		for (let index = 0; index < value.length; index += 1) {
			value[index] = coerceWithJsonSchema(value[index], asSchema(schema.items));
		}
	}
}

export function coerceWithUnionSchema(value: unknown, schemas: unknown[]): unknown {
	for (const schema of schemas) {
		const validator = getSubSchemaValidator(schema);
		if (validator?.Check(value)) return value;
	}
	for (const schema of schemas) {
		if (!isRecord(schema)) continue;
		const candidate = structuredClone(value);
		const coerced = coerceWithJsonSchema(candidate, asSchema(schema));
		const validator = getSubSchemaValidator(schema);
		if (validator?.Check(coerced)) return coerced;
	}
	return value;
}

export function coerceWithJsonSchema(value: unknown, schema: SchemaRecord): unknown {
	let nextValue = value;
	if (Array.isArray(schema.allOf)) {
		for (const nested of schema.allOf) {
			if (isRecord(nested)) nextValue = coerceWithJsonSchema(nextValue, asSchema(nested));
		}
	}
	if (Array.isArray(schema.anyOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.anyOf);
	}
	if (Array.isArray(schema.oneOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.oneOf);
	}
	const schemaTypes = getSchemaTypes(schema);
	const matchesUnionMember =
		schemaTypes.length > 1 &&
		schemaTypes.some((schemaType) => matchesJsonType(nextValue, schemaType));
	if (schemaTypes.length > 0 && !matchesUnionMember) {
		for (const schemaType of schemaTypes) {
			const candidate = coercePrimitiveByType(nextValue, schemaType);
			if (candidate !== nextValue) {
				nextValue = candidate;
				break;
			}
		}
	}
	if (
		schemaTypes.includes("object") &&
		typeof nextValue === "object" &&
		nextValue !== null &&
		!Array.isArray(nextValue)
	) {
		applySchemaObjectCoercion(nextValue as Record<string, unknown>, schema);
	}
	if (schemaTypes.includes("array") && Array.isArray(nextValue)) {
		applySchemaArrayCoercion(nextValue, schema);
	}
	return nextValue;
}

export function normalizeOptionalNulls(value: unknown, schema: SchemaRecord): void {
	if (Array.isArray(value)) {
		if (Array.isArray(schema.items)) {
			for (let index = 0; index < value.length; index += 1) {
				const itemSchema = schema.items[index];
				if (isRecord(itemSchema)) normalizeOptionalNulls(value[index], asSchema(itemSchema));
			}
		} else if (isRecord(schema.items)) {
			for (const item of value) normalizeOptionalNulls(item, asSchema(schema.items));
		}
		return;
	}
	const properties = schemaProperties(schema);
	if (typeof value !== "object" || value === null || !properties) return;
	const object = value as Record<string, unknown>;
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	for (const [key, propertySchema] of Object.entries(properties)) {
		if (!(key in object)) continue;
		if (
			object[key] === null &&
			!required.has(key) &&
			typeof propertySchema.$ref !== "string" &&
			getSubSchemaValidator(propertySchema)?.Check(null) === false
		) {
			delete object[key];
		} else {
			normalizeOptionalNulls(object[key], propertySchema);
		}
	}
}

export function formatValidationPath(error: ReturnType<Validator["Errors"]>[number]): string {
	if (error.keyword === "required") {
		const requiredProperties = error.params.requiredProperties as string[] | undefined;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

export function validateToolArguments(
	toolName: string,
	tool: PiRuntimeTool,
	rawArguments: unknown,
): unknown {
	const schema = asSchema(tool.parameters);
	const args = structuredClone(rawArguments);
	normalizeOptionalNulls(args, schema);
	Value.Convert(schema, args);
	const validator = getValidator(schema);
	if (!Object.getOwnPropertySymbols(schema).includes(TYPEBOX_KIND)) {
		const coerced = coerceWithJsonSchema(args, schema);
		if (coerced !== args) {
			if (isRecord(args) && isRecord(coerced)) {
				for (const key of Object.keys(args)) delete args[key];
				Object.assign(args, coerced);
			} else {
				return validator.Check(coerced) ? coerced : args;
			}
		}
	}
	if (validator.Check(args)) return args;
	const errors =
		validator
			.Errors(args)
			.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
			.join("\n") || "Unknown validation error";
	throw new Error(
		`Validation failed for tool "${toolName}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(rawArguments, null, 2)}`,
	);
}

export function createPiToolArgumentPreparer(
	tools: ReadonlyMap<string, PiRuntimeTool>,
): (toolName: string, rawArguments: unknown) => PiToolArgumentPreparation {
	return (toolName, rawArguments) => {
		const tool = tools.get(toolName);
		if (!tool) return { ok: false, message: `Tool ${toolName} not found` };
		try {
			const prepared = tool.prepareArguments ? tool.prepareArguments(rawArguments) : rawArguments;
			return { ok: true, value: validateToolArguments(toolName, tool, prepared) };
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
	};
}
