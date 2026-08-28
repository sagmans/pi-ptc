import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { TSchema } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import { Value } from "typebox/value";

import { isExclusiveToolName } from "./config.ts";
import type { CapturedPiSession, PiRuntimeTool } from "./pi-runtime.ts";
import type { DispatchKind } from "./scheduler.ts";
import type { ToolCatalogEntry } from "./tool-catalog.ts";

export const NESTED_PTC_TOOL_CALL_ID_PREFIX = "pi-ptc-nested-";

const OPERATION_ABORTED_MESSAGE = "Operation aborted";
const TOOL_EXECUTION_BLOCKED_MESSAGE = "Tool execution was blocked";
const SYNTHETIC_RUNTIME_NAME = "pi-ptc";
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");
type NestedPtcToolCallToken = {
	readonly toolCallId: string;
	active: boolean;
};
const nestedPtcToolCallStorage = new AsyncLocalStorage<NestedPtcToolCallToken>();
const validatorCache = new WeakMap<object, Validator>();
const ZERO_USAGE = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

type SchemaRecord = TSchema & Record<string, unknown>;

type ToolCall = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: unknown;
};

type SyntheticAssistantMessage = {
	role: "assistant";
	content: [ToolCall];
	api: string;
	provider: string;
	model: string;
	usage: typeof ZERO_USAGE;
	stopReason: "toolUse";
	timestamp: number;
};

type SyntheticAgentTool = PiRuntimeTool & {
	name: string;
	label: string;
	description: string;
};

type SyntheticAgentContext = {
	systemPrompt: string;
	messages: [SyntheticAssistantMessage];
	tools: SyntheticAgentTool[];
};

type BeforeToolCallResult = {
	block?: unknown;
	reason?: unknown;
	terminate?: unknown;
};

type AfterToolCallResult = {
	content?: unknown;
	details?: unknown;
	usage?: unknown;
	terminate?: unknown;
	isError?: unknown;
};

export type NestedToolRuntimeResult = Record<string, unknown> & {
	content?: unknown;
	details?: unknown;
	usage?: unknown;
	terminate?: unknown;
	addedToolNames?: readonly string[];
};

export type NestedToolDispatchRequest = {
	readonly name: string;
	readonly args: unknown;
	readonly signal?: AbortSignal;
	readonly onUpdate?: (partialResult: unknown) => Promise<void> | void;
};

export type NestedToolDispatchResult = {
	readonly toolCallId: string;
	readonly name: string;
	readonly rawArgs: unknown;
	readonly result: NestedToolRuntimeResult;
	readonly isError: boolean;
	readonly executionArgs?: unknown;
};

export type ToolExecutor = {
	dispatch(request: NestedToolDispatchRequest): Promise<NestedToolDispatchResult>;
};

export type CreateToolExecutorOptions = {
	readonly catalog: readonly ToolCatalogEntry[];
	readonly session: CapturedPiSession;
	readonly activateTools?: (names: readonly string[]) => Promise<void> | void;
};

type ImmediatePreparation = {
	kind: "immediate";
	result: NestedToolRuntimeResult;
	isError: true;
	hasExecutionArgs: boolean;
	executionArgs?: unknown;
};

type PreparedCall = {
	kind: "prepared";
	toolCall: ToolCall;
	tool: PiRuntimeTool;
	args: unknown;
	assistantMessage: SyntheticAssistantMessage;
	context: SyntheticAgentContext;
};

type Preparation = ImmediatePreparation | PreparedCall;

type ExecutedCall = {
	result: NestedToolRuntimeResult;
	isError: boolean;
};

type UpdateDeliveryOutcome = { kind: "delivered" } | { kind: "failed"; error: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

function asSchema(value: unknown): SchemaRecord {
	return value as SchemaRecord;
}

function schemaProperties(schema: SchemaRecord): Record<string, SchemaRecord> | undefined {
	return isRecord(schema.properties)
		? (schema.properties as Record<string, SchemaRecord>)
		: undefined;
}

function getSchemaTypes(schema: SchemaRecord): string[] {
	if (typeof schema.type === "string") return [schema.type];
	if (Array.isArray(schema.type)) {
		return schema.type.filter((type): type is string => typeof type === "string");
	}
	return [];
}

function matchesJsonType(value: unknown, type: string): boolean {
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

function getValidator(schema: SchemaRecord): Validator {
	const cached = validatorCache.get(schema);
	if (cached) return cached;
	const validator = Compile(schema);
	validatorCache.set(schema, validator);
	return validator;
}

function getSubSchemaValidator(schema: unknown): Validator | undefined {
	if (!isRecord(schema)) return undefined;
	try {
		return getValidator(asSchema(schema));
	} catch {
		return undefined;
	}
}

function coercePrimitiveByType(value: unknown, type: string): unknown {
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

function applySchemaObjectCoercion(value: Record<string, unknown>, schema: SchemaRecord): void {
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

function applySchemaArrayCoercion(value: unknown[], schema: SchemaRecord): void {
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

function coerceWithUnionSchema(value: unknown, schemas: unknown[]): unknown {
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

function coerceWithJsonSchema(value: unknown, schema: SchemaRecord): unknown {
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

function normalizeOptionalNulls(value: unknown, schema: SchemaRecord): void {
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

function formatValidationPath(error: ReturnType<Validator["Errors"]>[number]): string {
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

function validateToolArguments(toolName: string, tool: PiRuntimeTool, toolCall: ToolCall): unknown {
	const schema = asSchema(tool.parameters);
	const args = structuredClone(toolCall.arguments);
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
		`Validation failed for tool "${toolName}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`,
	);
}

function errorResult(message: string): NestedToolRuntimeResult {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function createSyntheticAgentTool(entry: ToolCatalogEntry): SyntheticAgentTool {
	const definition = isRecord(entry.definition) ? entry.definition : undefined;
	return {
		name: entry.name,
		label: typeof definition?.label === "string" ? definition.label : entry.name,
		description: typeof definition?.description === "string" ? definition.description : "",
		parameters: entry.executable.parameters,
		...(entry.executable.prepareArguments
			? { prepareArguments: entry.executable.prepareArguments }
			: {}),
		...(entry.executable.executionMode ? { executionMode: entry.executable.executionMode } : {}),
		execute: entry.executable.execute,
	};
}

function syntheticCallContext(
	toolCall: ToolCall,
	tools: SyntheticAgentTool[],
): { assistantMessage: SyntheticAssistantMessage; context: SyntheticAgentContext } {
	const assistantMessage: SyntheticAssistantMessage = {
		role: "assistant",
		content: [toolCall],
		api: SYNTHETIC_RUNTIME_NAME,
		provider: SYNTHETIC_RUNTIME_NAME,
		model: SYNTHETIC_RUNTIME_NAME,
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	return {
		assistantMessage,
		context: {
			systemPrompt: "",
			messages: [assistantMessage],
			tools,
		},
	};
}

async function prepareToolCall(
	session: CapturedPiSession,
	toolsByName: ReadonlyMap<string, ToolCatalogEntry>,
	contextTools: SyntheticAgentTool[],
	toolCall: ToolCall,
	signal?: AbortSignal,
): Promise<Preparation> {
	const entry = toolsByName.get(toolCall.name);
	if (!entry) {
		return {
			kind: "immediate",
			result: errorResult(`Tool ${toolCall.name} not found`),
			isError: true,
			hasExecutionArgs: false,
		};
	}
	let executionArgs: unknown;
	let hasExecutionArgs = false;
	try {
		const preparedArguments = entry.executable.prepareArguments
			? entry.executable.prepareArguments(toolCall.arguments)
			: toolCall.arguments;
		const preparedToolCall =
			preparedArguments === toolCall.arguments
				? toolCall
				: { ...toolCall, arguments: preparedArguments };
		executionArgs = validateToolArguments(toolCall.name, entry.executable, preparedToolCall);
		hasExecutionArgs = true;
		const synthetic = syntheticCallContext(toolCall, contextTools);
		const beforeResult = (await session.beforeToolCall(
			{
				assistantMessage: synthetic.assistantMessage,
				toolCall,
				args: executionArgs,
				context: synthetic.context,
			},
			signal,
		)) as BeforeToolCallResult | undefined;
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: errorResult(OPERATION_ABORTED_MESSAGE),
				isError: true,
				hasExecutionArgs,
				executionArgs,
			};
		}
		if (beforeResult?.block) {
			const reason =
				typeof beforeResult.reason === "string" && beforeResult.reason
					? beforeResult.reason
					: TOOL_EXECUTION_BLOCKED_MESSAGE;
			const result = errorResult(reason);
			if (beforeResult.terminate === true) result.terminate = true;
			return {
				kind: "immediate",
				result,
				isError: true,
				hasExecutionArgs,
				executionArgs,
			};
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: errorResult(OPERATION_ABORTED_MESSAGE),
				isError: true,
				hasExecutionArgs,
				executionArgs,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool: entry.executable,
			args: executionArgs,
			assistantMessage: synthetic.assistantMessage,
			context: synthetic.context,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: errorResult(errorMessage(error)),
			isError: true,
			hasExecutionArgs,
			...(hasExecutionArgs ? { executionArgs } : {}),
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedCall,
	session: CapturedPiSession,
	signal: AbortSignal | undefined,
	onUpdate: NestedToolDispatchRequest["onUpdate"],
): Promise<ExecutedCall> {
	const updateEvents: Promise<UpdateDeliveryOutcome>[] = [];
	let acceptingUpdates = true;
	let executed: ExecutedCall;
	try {
		const result = (await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args,
			signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				const deliveries: Promise<unknown>[] = [];
				try {
					deliveries.push(Promise.resolve(onUpdate?.(partialResult)));
				} catch (error) {
					deliveries.push(Promise.reject(error));
				}
				try {
					deliveries.push(
						Promise.resolve(
							session.extensionRunner.emit({
								type: "tool_execution_update",
								toolCallId: prepared.toolCall.id,
								toolName: prepared.toolCall.name,
								args: prepared.toolCall.arguments,
								partialResult,
							}),
						),
					);
				} catch (error) {
					deliveries.push(Promise.reject(error));
				}
				updateEvents.push(
					Promise.allSettled(deliveries).then((settled) => {
						const failure = settled.find((delivery) => delivery.status === "rejected");
						return failure ? { kind: "failed", error: failure.reason } : { kind: "delivered" };
					}),
				);
			},
		)) as NestedToolRuntimeResult;
		executed = { result, isError: false };
	} catch (error) {
		executed = { result: errorResult(errorMessage(error)), isError: true };
	} finally {
		acceptingUpdates = false;
	}
	const updateOutcomes = await Promise.all(updateEvents);
	const updateFailure = updateOutcomes.find(
		(outcome): outcome is Extract<UpdateDeliveryOutcome, { kind: "failed" }> =>
			outcome.kind === "failed",
	);
	return executed.isError || !updateFailure
		? executed
		: { result: errorResult(errorMessage(updateFailure.error)), isError: true };
}

async function finalizeExecutedToolCall(
	prepared: PreparedCall,
	executed: ExecutedCall,
	session: CapturedPiSession,
	signal?: AbortSignal,
): Promise<ExecutedCall> {
	let result = executed.result;
	let isError = executed.isError;
	try {
		const afterResult = (await session.afterToolCall(
			{
				assistantMessage: prepared.assistantMessage,
				toolCall: prepared.toolCall,
				args: prepared.args,
				result,
				isError,
				context: prepared.context,
			},
			signal,
		)) as AfterToolCallResult | undefined;
		if (afterResult) {
			result = {
				...result,
				content: afterResult.content ?? result.content,
				details: afterResult.details ?? result.details,
				usage: afterResult.usage ?? result.usage,
				terminate: afterResult.terminate ?? result.terminate,
			};
			isError = typeof afterResult.isError === "boolean" ? afterResult.isError : isError;
		}
	} catch (error) {
		result = errorResult(errorMessage(error));
		isError = true;
	}
	return { result, isError };
}

function retainedAddedToolNames(result: NestedToolRuntimeResult): readonly string[] | undefined {
	return Array.isArray(result.addedToolNames) && result.addedToolNames.length > 0
		? result.addedToolNames
		: undefined;
}

export function isNestedPtcToolCall(toolCallId?: string): boolean {
	const token = nestedPtcToolCallStorage.getStore();
	return token?.active === true && (toolCallId === undefined || token.toolCallId === toolCallId);
}

export function classifyToolDispatch(entry: ToolCatalogEntry): DispatchKind {
	if (entry.executable.executionMode === "sequential") return "exclusive";
	if (entry.executable.executionMode === "parallel") return "parallel";
	return isExclusiveToolName(entry.name) ? "exclusive" : "parallel";
}

export function createToolExecutor(options: CreateToolExecutorOptions): ToolExecutor {
	const catalog = [...options.catalog];
	const toolsByName = new Map(catalog.map((entry) => [entry.name, entry]));
	const contextTools = catalog.map(createSyntheticAgentTool);

	return Object.freeze({
		dispatch(request: NestedToolDispatchRequest): Promise<NestedToolDispatchResult> {
			const toolCall: ToolCall = {
				type: "toolCall",
				id: `${NESTED_PTC_TOOL_CALL_ID_PREFIX}${randomUUID()}`,
				name: request.name,
				arguments: request.args,
			};
			const token: NestedPtcToolCallToken = { toolCallId: toolCall.id, active: true };
			return nestedPtcToolCallStorage.run(token, async () => {
				try {
					await options.session.extensionRunner.emit({
						type: "tool_execution_start",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						args: toolCall.arguments,
					});
					const preparation = await prepareToolCall(
						options.session,
						toolsByName,
						contextTools,
						toolCall,
						request.signal,
					);
					let finalized: ExecutedCall;
					let executionArgs: unknown;
					let hasExecutionArgs = false;
					if (preparation.kind === "immediate") {
						finalized = preparation;
						hasExecutionArgs = preparation.hasExecutionArgs;
						executionArgs = preparation.executionArgs;
					} else {
						hasExecutionArgs = true;
						executionArgs = preparation.args;
						const executed = await executePreparedToolCall(
							preparation,
							options.session,
							request.signal,
							request.onUpdate,
						);
						finalized = await finalizeExecutedToolCall(
							preparation,
							executed,
							options.session,
							request.signal,
						);
					}
					await options.session.extensionRunner.emit({
						type: "tool_execution_end",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						result: finalized.result,
						isError: finalized.isError,
					});
					const addedToolNames = retainedAddedToolNames(finalized.result);
					if (addedToolNames) await options.activateTools?.(addedToolNames);
					return {
						toolCallId: toolCall.id,
						name: toolCall.name,
						rawArgs: toolCall.arguments,
						result: finalized.result,
						isError: finalized.isError,
						...(hasExecutionArgs ? { executionArgs } : {}),
					};
				} finally {
					token.active = false;
				}
			});
		},
	});
}
