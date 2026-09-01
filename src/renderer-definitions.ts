import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { PtcDefinitionRegistry, PtcRenderDefinition } from "./renderer-contract.ts";
import type { ToolCatalogEntry } from "./tool-catalog.ts";

export const MAX_RENDER_DEFINITION_PROTOTYPE_DEPTH = 16;

export const RENDER_DEFINITION_KEYS = ["renderCall", "renderResult", "renderShell"] as const;

function isObjectLike(value: unknown): value is object {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

function readRenderDataValues(
	value: object,
): Partial<Record<(typeof RENDER_DEFINITION_KEYS)[number], unknown>> | undefined {
	const values: Partial<Record<(typeof RENDER_DEFINITION_KEYS)[number], unknown>> = {};
	const unresolved = new Set<string>(RENDER_DEFINITION_KEYS);
	const visited = new Set<object>();
	let current: object | null = value;
	for (let depth = 0; current !== null; depth += 1) {
		if (depth > MAX_RENDER_DEFINITION_PROTOTYPE_DEPTH || visited.has(current)) return undefined;
		visited.add(current);
		for (const key of RENDER_DEFINITION_KEYS) {
			if (!unresolved.has(key)) continue;
			const descriptor = Object.getOwnPropertyDescriptor(current, key);
			if (!descriptor) continue;
			unresolved.delete(key);
			if (Object.hasOwn(descriptor, "value")) values[key] = descriptor.value;
		}
		if (unresolved.size === 0) return values;
		if (depth === MAX_RENDER_DEFINITION_PROTOTYPE_DEPTH) return undefined;
		current = Object.getPrototypeOf(current);
	}
	return values;
}

export function createPtcDefinitionRegistry(
	catalog: readonly ToolCatalogEntry[],
): PtcDefinitionRegistry {
	const definitions = new Map<string, PtcRenderDefinition>();
	for (const entry of catalog) {
		const definition = projectRenderDefinition(entry.definition);
		if (definition) definitions.set(entry.name, definition);
	}
	return definitions;
}

export function createNativeDefinitions(cwd: string): Map<string, PtcRenderDefinition> {
	return new Map([
		["bash", createBashToolDefinition(cwd) as unknown as ToolDefinition],
		["edit", createEditToolDefinition(cwd) as unknown as ToolDefinition],
		["find", createFindToolDefinition(cwd) as unknown as ToolDefinition],
		["grep", createGrepToolDefinition(cwd) as unknown as ToolDefinition],
		["ls", createLsToolDefinition(cwd) as unknown as ToolDefinition],
		["read", createReadToolDefinition(cwd) as unknown as ToolDefinition],
		["write", createWriteToolDefinition(cwd) as unknown as ToolDefinition],
	]);
}

export function mergeDefinitions(
	target: Map<string, PtcRenderDefinition>,
	source: PtcDefinitionRegistry,
	overrideExisting: boolean,
): void {
	for (const [name, rawDefinition] of source) {
		const definition = projectRenderDefinition(rawDefinition);
		if (!definition) continue;
		const existing = target.get(name);
		if (existing && !overrideExisting) continue;
		target.set(name, existing ? { ...existing, ...definition } : definition);
	}
}

export function projectRenderDefinition(value: unknown): PtcRenderDefinition | undefined {
	if (!isObjectLike(value)) return undefined;
	try {
		const values = readRenderDataValues(value);
		if (!values) return undefined;
		const definition: PtcRenderDefinition = {};
		if (typeof values.renderCall === "function") {
			definition.renderCall = values.renderCall as NonNullable<ToolDefinition["renderCall"]>;
		}
		if (typeof values.renderResult === "function") {
			definition.renderResult = values.renderResult as NonNullable<ToolDefinition["renderResult"]>;
		}
		if (values.renderShell === "default" || values.renderShell === "self") {
			definition.renderShell = values.renderShell;
		}
		return Object.keys(definition).length === 0 ? undefined : definition;
	} catch {
		return undefined;
	}
}
