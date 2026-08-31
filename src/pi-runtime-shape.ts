import type {
	PiExtensionRunner,
	PiRuntimeEventFinalizers,
	PiSharedRuntime,
} from "./pi-runtime-contract.ts";
import { PI_RUNTIME_DIAGNOSTICS, PI_RUNTIME_PRIVATE_PROPERTIES } from "./pi-runtime-contract.ts";
import type {
	BoundPiExtensionRunner,
	RunnerEventMethod,
	RunnerEventMethodShapes,
	RunnerEventProperty,
	RuntimeActionDescriptors,
	SessionParts,
	ToolSnapshot,
} from "./pi-runtime-registry.ts";
import {
	AFTER_TOOL_CALL_PROPERTY,
	AGENT_PROPERTY,
	BEFORE_TOOL_CALL_PROPERTY,
	CREATE_CONTEXT_PROPERTY,
	DESCRIPTOR_VALUE_PROPERTY,
	EMIT_BEFORE_AGENT_START_PROPERTY,
	EMIT_PROPERTY,
	EMIT_TOOL_CALL_PROPERTY,
	EXTENSION_RUNNER_PROPERTY,
	FINALIZE_BEFORE_AGENT_START_PROPERTY,
	FINALIZE_TOOL_CALL_PROPERTY,
	GET_ACTIVE_TOOLS_PROPERTY,
	GET_TOOL_DEFINITION_PROPERTY,
	isRecord,
	REFRESH_TOOLS_PROPERTY,
	RUNTIME_ACTION_PROPERTIES,
	RUNTIME_EVENT_PROPERTIES,
	SET_ACTIVE_TOOLS_PROPERTY,
} from "./pi-runtime-registry.ts";
import {
	dataDescriptorsMatch,
	runnerEventShapesMatch,
	validateRunnerEventMethod,
	validateToolRegistry,
} from "./pi-runtime-tool-shape.ts";

export function validateSession(
	session: object,
): { compatible: true; parts: SessionParts } | { compatible: false; diagnostic: string } {
	if (!isRecord(session)) {
		return { compatible: false, diagnostic: PI_RUNTIME_DIAGNOSTICS.MISSING_TOOL_LOOKUP };
	}
	const getToolDefinition = session[GET_TOOL_DEFINITION_PROPERTY];
	if (typeof getToolDefinition !== "function") {
		return { compatible: false, diagnostic: PI_RUNTIME_DIAGNOSTICS.MISSING_TOOL_LOOKUP };
	}
	const extensionRunner = session[EXTENSION_RUNNER_PROPERTY];
	if (!isRecord(extensionRunner)) {
		return { compatible: false, diagnostic: PI_RUNTIME_DIAGNOSTICS.MISSING_EXTENSION_RUNNER };
	}
	const createContext = extensionRunner[CREATE_CONTEXT_PROPERTY];
	if (typeof createContext !== "function") {
		return { compatible: false, diagnostic: PI_RUNTIME_DIAGNOSTICS.MISSING_CREATE_CONTEXT };
	}
	const emit = extensionRunner[EMIT_PROPERTY];
	if (typeof emit !== "function") {
		return { compatible: false, diagnostic: PI_RUNTIME_DIAGNOSTICS.MISSING_EMIT };
	}
	const emitToolCallValidation = validateRunnerEventMethod(
		extensionRunner,
		EMIT_TOOL_CALL_PROPERTY,
		PI_RUNTIME_DIAGNOSTICS.MISSING_EMIT_TOOL_CALL,
		PI_RUNTIME_DIAGNOSTICS.UNPATCHABLE_EMIT_TOOL_CALL,
	);
	if (!emitToolCallValidation.compatible) return emitToolCallValidation;
	const emitBeforeAgentStartValidation = validateRunnerEventMethod(
		extensionRunner,
		EMIT_BEFORE_AGENT_START_PROPERTY,
		PI_RUNTIME_DIAGNOSTICS.MISSING_EMIT_BEFORE_AGENT_START,
		PI_RUNTIME_DIAGNOSTICS.UNPATCHABLE_EMIT_BEFORE_AGENT_START,
	);
	if (!emitBeforeAgentStartValidation.compatible) return emitBeforeAgentStartValidation;
	const eventMethods: RunnerEventMethodShapes = Object.freeze({
		emitToolCall: emitToolCallValidation.shape,
		emitBeforeAgentStart: emitBeforeAgentStartValidation.shape,
	});
	const sharedRuntime = extensionRunner[PI_RUNTIME_PRIVATE_PROPERTIES.RUNNER_RUNTIME];
	if (!isRecord(sharedRuntime)) {
		return { compatible: false, diagnostic: PI_RUNTIME_DIAGNOSTICS.MISSING_RUNNER_RUNTIME };
	}
	const getActiveTools = sharedRuntime[GET_ACTIVE_TOOLS_PROPERTY];
	if (typeof getActiveTools !== "function") {
		return { compatible: false, diagnostic: PI_RUNTIME_DIAGNOSTICS.MISSING_GET_ACTIVE_TOOLS };
	}
	const setActiveTools = sharedRuntime[SET_ACTIVE_TOOLS_PROPERTY];
	if (typeof setActiveTools !== "function") {
		return { compatible: false, diagnostic: PI_RUNTIME_DIAGNOSTICS.MISSING_SET_ACTIVE_TOOLS };
	}
	const refreshTools = sharedRuntime[REFRESH_TOOLS_PROPERTY];
	if (typeof refreshTools !== "function") {
		return { compatible: false, diagnostic: PI_RUNTIME_DIAGNOSTICS.MISSING_REFRESH_TOOLS };
	}
	const registryResult = validateToolRegistry(session[PI_RUNTIME_PRIVATE_PROPERTIES.TOOL_REGISTRY]);
	if (!registryResult.compatible) return registryResult;
	const agent = session[AGENT_PROPERTY];
	if (!isRecord(agent)) {
		return { compatible: false, diagnostic: PI_RUNTIME_DIAGNOSTICS.MISSING_AGENT };
	}
	const beforeToolCall = agent[BEFORE_TOOL_CALL_PROPERTY];
	if (typeof beforeToolCall !== "function") {
		return { compatible: false, diagnostic: PI_RUNTIME_DIAGNOSTICS.MISSING_BEFORE_TOOL_CALL };
	}
	const afterToolCall = agent[AFTER_TOOL_CALL_PROPERTY];
	if (typeof afterToolCall !== "function") {
		return { compatible: false, diagnostic: PI_RUNTIME_DIAGNOSTICS.MISSING_AFTER_TOOL_CALL };
	}
	return {
		compatible: true,
		parts: Object.freeze({
			extensionRunner: extensionRunner as BoundPiExtensionRunner,
			createContext: createContext as PiExtensionRunner["createContext"],
			emit: emit as PiExtensionRunner["emit"],
			eventMethods,
			sharedRuntime: sharedRuntime as PiSharedRuntime,
			getActiveTools: getActiveTools as PiSharedRuntime["getActiveTools"],
			setActiveTools: setActiveTools as PiSharedRuntime["setActiveTools"],
			refreshTools: refreshTools as PiSharedRuntime["refreshTools"],
			toolRegistry: registryResult.registry,
			toolSnapshots: registryResult.toolSnapshots,
			getToolDefinition: getToolDefinition as (name: string) => unknown,
			agent,
			beforeToolCall: beforeToolCall as (...args: unknown[]) => Promise<unknown>,
			afterToolCall: afterToolCall as (...args: unknown[]) => Promise<unknown>,
		}),
	};
}

export function toolSnapshotsMatch(
	currentSnapshots: readonly ToolSnapshot[],
	expectedSnapshots: readonly ToolSnapshot[],
): boolean {
	if (currentSnapshots.length !== expectedSnapshots.length) return false;
	return currentSnapshots.every((current, index) => {
		const expected = expectedSnapshots[index];
		return (
			expected !== undefined &&
			current.name === expected.name &&
			current.entry === expected.entry &&
			current.parameters === expected.parameters &&
			current.prepareArguments === expected.prepareArguments &&
			current.executionMode === expected.executionMode &&
			current.execute === expected.execute
		);
	});
}

export function sessionPartsMatch(current: SessionParts, expected: SessionParts): boolean {
	return (
		current.extensionRunner === expected.extensionRunner &&
		current.createContext === expected.createContext &&
		current.emit === expected.emit &&
		runnerEventShapesMatch(current.eventMethods, expected.eventMethods) &&
		current.sharedRuntime === expected.sharedRuntime &&
		current.getActiveTools === expected.getActiveTools &&
		current.setActiveTools === expected.setActiveTools &&
		current.refreshTools === expected.refreshTools &&
		current.toolRegistry === expected.toolRegistry &&
		current.getToolDefinition === expected.getToolDefinition &&
		current.agent === expected.agent &&
		current.beforeToolCall === expected.beforeToolCall &&
		current.afterToolCall === expected.afterToolCall &&
		toolSnapshotsMatch(current.toolSnapshots, expected.toolSnapshots)
	);
}

export function sessionPartsMatchWithRuntimeActions(
	current: SessionParts,
	expected: SessionParts,
	actions: PiSharedRuntime,
): boolean {
	return (
		current.extensionRunner === expected.extensionRunner &&
		current.createContext === expected.createContext &&
		current.emit === expected.emit &&
		runnerEventShapesMatch(current.eventMethods, expected.eventMethods) &&
		current.sharedRuntime === expected.sharedRuntime &&
		current.getActiveTools === actions.getActiveTools &&
		current.setActiveTools === actions.setActiveTools &&
		current.refreshTools === actions.refreshTools &&
		current.toolRegistry === expected.toolRegistry &&
		current.getToolDefinition === expected.getToolDefinition &&
		current.agent === expected.agent &&
		current.beforeToolCall === expected.beforeToolCall &&
		current.afterToolCall === expected.afterToolCall &&
		toolSnapshotsMatch(current.toolSnapshots, expected.toolSnapshots)
	);
}

export function sessionPartsMatchAfterToolRefresh(
	current: SessionParts,
	expected: SessionParts,
	actions: PiSharedRuntime,
): boolean {
	return (
		current.extensionRunner === expected.extensionRunner &&
		current.createContext === expected.createContext &&
		current.emit === expected.emit &&
		runnerEventShapesMatch(current.eventMethods, expected.eventMethods) &&
		current.sharedRuntime === expected.sharedRuntime &&
		current.getActiveTools === actions.getActiveTools &&
		current.setActiveTools === actions.setActiveTools &&
		current.refreshTools === actions.refreshTools &&
		current.getToolDefinition === expected.getToolDefinition &&
		current.agent === expected.agent &&
		current.beforeToolCall === expected.beforeToolCall &&
		current.afterToolCall === expected.afterToolCall
	);
}

export function validateRuntimeActionReplacements(value: unknown): value is PiSharedRuntime {
	if (!isRecord(value)) return false;
	return RUNTIME_ACTION_PROPERTIES.every((property) => typeof value[property] === "function");
}

export function validateRuntimeEventFinalizers(value: unknown): value is PiRuntimeEventFinalizers {
	return (
		isRecord(value) &&
		typeof value[FINALIZE_TOOL_CALL_PROPERTY] === "function" &&
		typeof value[FINALIZE_BEFORE_AGENT_START_PROPERTY] === "function"
	);
}

export function runnerEventWrappersMatch(
	current: RunnerEventMethodShapes,
	runner: object,
	wrappers: Record<RunnerEventProperty, RunnerEventMethod>,
): boolean {
	return RUNTIME_EVENT_PROPERTIES.every((property) => {
		const shape = current[property];
		return (
			shape.own &&
			shape.descriptorOwner === runner &&
			shape.method === wrappers[property] &&
			shape.descriptor.value === wrappers[property]
		);
	});
}

export function sessionPartsMatchWithRuntimeEventFinalizers(
	current: SessionParts,
	expected: SessionParts,
	wrappers: Record<RunnerEventProperty, RunnerEventMethod>,
): boolean {
	return (
		current.extensionRunner === expected.extensionRunner &&
		current.createContext === expected.createContext &&
		current.emit === expected.emit &&
		runnerEventWrappersMatch(current.eventMethods, expected.extensionRunner, wrappers) &&
		current.sharedRuntime === expected.sharedRuntime &&
		current.getActiveTools === expected.getActiveTools &&
		current.setActiveTools === expected.setActiveTools &&
		current.refreshTools === expected.refreshTools &&
		current.toolRegistry === expected.toolRegistry &&
		current.getToolDefinition === expected.getToolDefinition &&
		current.agent === expected.agent &&
		current.beforeToolCall === expected.beforeToolCall &&
		current.afterToolCall === expected.afterToolCall &&
		toolSnapshotsMatch(current.toolSnapshots, expected.toolSnapshots)
	);
}

export function inheritedRunnerEventSourcesMatch(shapes: RunnerEventMethodShapes): boolean {
	return RUNTIME_EVENT_PROPERTIES.every((property) => {
		const shape = shapes[property];
		return (
			shape.own ||
			dataDescriptorsMatch(
				Object.getOwnPropertyDescriptor(shape.descriptorOwner, property),
				shape.descriptor,
			)
		);
	});
}

export function getRuntimeActionDescriptors(
	runtime: PiSharedRuntime,
	expected: PiSharedRuntime,
): RuntimeActionDescriptors | undefined {
	const descriptors = {} as RuntimeActionDescriptors;
	for (const property of RUNTIME_ACTION_PROPERTIES) {
		const descriptor = Object.getOwnPropertyDescriptor(runtime, property);
		if (
			!descriptor ||
			!Object.hasOwn(descriptor, DESCRIPTOR_VALUE_PROPERTY) ||
			descriptor.value !== expected[property] ||
			(descriptor.configurable !== true && descriptor.writable !== true)
		) {
			return undefined;
		}
		descriptors[property] = descriptor;
	}
	return descriptors;
}
