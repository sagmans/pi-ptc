import type { PiRuntimeTool } from "./pi-runtime-contract.ts";
import { diagnostic, PI_RUNTIME_DIAGNOSTICS } from "./pi-runtime-contract.ts";
import type {
	RunnerEventMethod,
	RunnerEventMethodShape,
	RunnerEventMethodShapes,
	RunnerEventProperty,
	ToolSnapshot,
} from "./pi-runtime-registry.ts";
import {
	DESCRIPTOR_GET_PROPERTY,
	DESCRIPTOR_SET_PROPERTY,
	DESCRIPTOR_VALUE_PROPERTY,
	EXECUTE_PROPERTY,
	EXECUTION_MODE_PROPERTY,
	isRecord,
	MAP_ENTRIES_METHOD,
	PARALLEL_EXECUTION_MODE,
	PARAMETERS_PROPERTY,
	PREPARE_ARGUMENTS_PROPERTY,
	RUNTIME_EVENT_PROPERTIES,
	SEQUENTIAL_EXECUTION_MODE,
} from "./pi-runtime-registry.ts";

export function validateToolRegistry(registry: unknown):
	| {
			compatible: true;
			registry: Map<string, PiRuntimeTool>;
			toolSnapshots: readonly ToolSnapshot[];
	  }
	| { compatible: false; diagnostic: string } {
	if (!(registry instanceof Map)) {
		return {
			compatible: false,
			diagnostic: PI_RUNTIME_DIAGNOSTICS.MISSING_TOOL_REGISTRY,
		};
	}
	const toolSnapshots: ToolSnapshot[] = [];
	const entries = Reflect.apply(MAP_ENTRIES_METHOD, registry, []) as IterableIterator<
		[unknown, unknown]
	>;
	for (const [name, entry] of entries) {
		if (typeof name !== "string") {
			return {
				compatible: false,
				diagnostic: PI_RUNTIME_DIAGNOSTICS.INVALID_TOOL_NAME,
			};
		}
		if (!isRecord(entry) || !isRecord(entry[PARAMETERS_PROPERTY])) {
			return {
				compatible: false,
				diagnostic: diagnostic(PI_RUNTIME_DIAGNOSTICS.MISSING_TOOL_PARAMETERS, name),
			};
		}
		const parameters = entry[PARAMETERS_PROPERTY];
		const prepareArguments = entry[PREPARE_ARGUMENTS_PROPERTY];
		if (prepareArguments !== undefined && typeof prepareArguments !== "function") {
			return {
				compatible: false,
				diagnostic: diagnostic(PI_RUNTIME_DIAGNOSTICS.INVALID_PREPARE_ARGUMENTS, name),
			};
		}
		const executionMode = entry[EXECUTION_MODE_PROPERTY];
		if (
			executionMode !== undefined &&
			executionMode !== PARALLEL_EXECUTION_MODE &&
			executionMode !== SEQUENTIAL_EXECUTION_MODE
		) {
			return {
				compatible: false,
				diagnostic: diagnostic(PI_RUNTIME_DIAGNOSTICS.INVALID_EXECUTION_MODE, name),
			};
		}
		const execute = entry[EXECUTE_PROPERTY];
		if (typeof execute !== "function") {
			return {
				compatible: false,
				diagnostic: diagnostic(PI_RUNTIME_DIAGNOSTICS.MISSING_TOOL_EXECUTE, name),
			};
		}
		toolSnapshots.push(
			Object.freeze({
				name,
				entry: entry as PiRuntimeTool,
				parameters: parameters as object,
				prepareArguments: prepareArguments as ((args: unknown) => unknown) | undefined,
				executionMode: executionMode as "parallel" | "sequential" | undefined,
				execute: execute as PiRuntimeTool["execute"],
			}),
		);
	}
	return {
		compatible: true,
		registry: registry as Map<string, PiRuntimeTool>,
		toolSnapshots: Object.freeze(toolSnapshots),
	};
}

export function dataDescriptorsMatch(
	current: PropertyDescriptor | undefined,
	expected: PropertyDescriptor,
): boolean {
	return (
		current !== undefined &&
		Object.hasOwn(current, DESCRIPTOR_VALUE_PROPERTY) &&
		current.value === expected.value &&
		current.configurable === expected.configurable &&
		current.enumerable === expected.enumerable &&
		current.writable === expected.writable &&
		!Object.hasOwn(current, DESCRIPTOR_GET_PROPERTY) &&
		!Object.hasOwn(current, DESCRIPTOR_SET_PROPERTY)
	);
}

export function validateRunnerEventMethod(
	runner: object,
	property: RunnerEventProperty,
	missingDiagnostic: string,
	unpatchableDiagnostic: string,
): { compatible: true; shape: RunnerEventMethodShape } | { compatible: false; diagnostic: string } {
	try {
		const ownDescriptor = Object.getOwnPropertyDescriptor(runner, property);
		if (ownDescriptor !== undefined) {
			if (
				!Object.hasOwn(ownDescriptor, DESCRIPTOR_VALUE_PROPERTY) ||
				typeof ownDescriptor.value !== "function"
			) {
				return { compatible: false, diagnostic: missingDiagnostic };
			}
			if (ownDescriptor.configurable !== true && ownDescriptor.writable !== true) {
				return { compatible: false, diagnostic: unpatchableDiagnostic };
			}
			return {
				compatible: true,
				shape: Object.freeze({
					property,
					method: ownDescriptor.value as RunnerEventMethod,
					descriptorOwner: runner,
					descriptor: ownDescriptor,
					own: true,
				}),
			};
		}
		let descriptorOwner = Object.getPrototypeOf(runner) as object | null;
		while (descriptorOwner !== null) {
			const descriptor = Object.getOwnPropertyDescriptor(descriptorOwner, property);
			if (descriptor !== undefined) {
				if (
					!Object.hasOwn(descriptor, DESCRIPTOR_VALUE_PROPERTY) ||
					typeof descriptor.value !== "function"
				) {
					return { compatible: false, diagnostic: missingDiagnostic };
				}
				if (!Object.isExtensible(runner)) {
					return { compatible: false, diagnostic: unpatchableDiagnostic };
				}
				return {
					compatible: true,
					shape: Object.freeze({
						property,
						method: descriptor.value as RunnerEventMethod,
						descriptorOwner,
						descriptor,
						own: false,
					}),
				};
			}
			descriptorOwner = Object.getPrototypeOf(descriptorOwner) as object | null;
		}
		return { compatible: false, diagnostic: missingDiagnostic };
	} catch (error) {
		return {
			compatible: false,
			diagnostic: diagnostic(unpatchableDiagnostic, String(error)),
		};
	}
}

export function runnerEventShapesMatch(
	current: RunnerEventMethodShapes,
	expected: RunnerEventMethodShapes,
): boolean {
	return RUNTIME_EVENT_PROPERTIES.every((property) => {
		const currentShape = current[property];
		const expectedShape = expected[property];
		return (
			currentShape.method === expectedShape.method &&
			currentShape.descriptorOwner === expectedShape.descriptorOwner &&
			currentShape.own === expectedShape.own &&
			dataDescriptorsMatch(currentShape.descriptor, expectedShape.descriptor)
		);
	});
}
