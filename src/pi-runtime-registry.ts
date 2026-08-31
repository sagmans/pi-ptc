import type {
	PiExtensionRunner,
	PiRuntimeCapture,
	PiRuntimeInstaller,
	PiRuntimePatchInstallation,
	PiRuntimeTool,
	PiSharedRuntime,
	PtcTransportOwnership,
} from "./pi-runtime-contract.ts";
import { diagnostic, PI_RUNTIME_DIAGNOSTICS } from "./pi-runtime-contract.ts";

export const BIND_EXTENSIONS_PROPERTY = "bindExtensions";

export const RELOAD_PROPERTY = "reload";

export const EXTENSION_RUNNER_PROPERTY = "extensionRunner";

export const GET_TOOL_DEFINITION_PROPERTY = "getToolDefinition";

export const AGENT_PROPERTY = "agent";

export const BEFORE_TOOL_CALL_PROPERTY = "beforeToolCall";

export const AFTER_TOOL_CALL_PROPERTY = "afterToolCall";

export const CREATE_CONTEXT_PROPERTY = "createContext";

export const EMIT_PROPERTY = "emit";

export const EMIT_TOOL_CALL_PROPERTY = "emitToolCall";

export const EMIT_BEFORE_AGENT_START_PROPERTY = "emitBeforeAgentStart";

export const GET_ACTIVE_TOOLS_PROPERTY = "getActiveTools";

export const SET_ACTIVE_TOOLS_PROPERTY = "setActiveTools";

export const REFRESH_TOOLS_PROPERTY = "refreshTools";

export const PARAMETERS_PROPERTY = "parameters";

export const PREPARE_ARGUMENTS_PROPERTY = "prepareArguments";

export const EXECUTION_MODE_PROPERTY = "executionMode";

export const EXECUTE_PROPERTY = "execute";

export const PTC_TOOL_NAME = "ptc";

export const RUNTIME_ACTION_PROPERTIES = Object.freeze([
	GET_ACTIVE_TOOLS_PROPERTY,
	SET_ACTIVE_TOOLS_PROPERTY,
	REFRESH_TOOLS_PROPERTY,
] as const);

export const RUNTIME_EVENT_PROPERTIES = Object.freeze([
	EMIT_TOOL_CALL_PROPERTY,
	EMIT_BEFORE_AGENT_START_PROPERTY,
] as const);

export const FINALIZE_TOOL_CALL_PROPERTY = "finalizeToolCall";

export const FINALIZE_BEFORE_AGENT_START_PROPERTY = "finalizeBeforeAgentStart";

export const RESTORE_INHERITED_EVENT_METHOD_ERROR_PREFIX = "Could not restore inherited";

export const PARALLEL_EXECUTION_MODE = "parallel";

export const SEQUENTIAL_EXECUTION_MODE = "sequential";

export const PATCH_REGISTRY_SYMBOL_NAME = "pi-ptc.pi-runtime.patch-registry.v1";

export const LIFECYCLE_COORDINATOR_REGISTRY_SYMBOL_NAME =
	"pi-ptc.pi-runtime.lifecycle-coordinator-registry.v1";

export const SHARED_PATCH_LEASE_REGISTRY_SYMBOL_NAME =
	"pi-ptc.pi-runtime.shared-patch-lease-registry.v1";

export const TOOL_INSTALLER_SYMBOL_NAME = "pi-ptc.pi-runtime.installer.v1";

export const COMPATIBILITY_ERROR_NAME = "PiRuntimeCompatibilityError";

export const BIND_INVOCATION_SLOT_KIND = "bind-invocation";

export const RELOAD_INVOCATION_SLOT_KIND = "reload-invocation";

export const ASSOCIATION_SLOT_KIND = "association";

export const SLOT_BY_SESSION_PROPERTY = "slotBySession";

export const ACTIVE_PROPERTY = "active";

export const INSTALLATIONS_PROPERTY = "installations";

export const BIND_EXTENSIONS_PATCH_PROPERTY = "bindExtensions";

export const RELOAD_PATCH_PROPERTY = "reload";

export const COORDINATOR_PROPERTY = "coordinator";

export const INSTALLATION_PROPERTY = "installation";

export const STATE_PROPERTY = "state";

export const COMPATIBLE_PROPERTY = "compatible";

export const TEARDOWN_PROPERTY = "teardown";

export const PATCH_PROPERTY_PROPERTY = "property";

export const ORIGINAL_DESCRIPTOR_PROPERTY = "originalDescriptor";

export const ORIGINAL_FUNCTION_PROPERTY = "originalFunction";

export const PATCHED_FUNCTION_PROPERTY = "patchedFunction";

export const DESCRIPTOR_VALUE_PROPERTY = "value";

export const DESCRIPTOR_CONFIGURABLE_PROPERTY = "configurable";

export const DESCRIPTOR_ENUMERABLE_PROPERTY = "enumerable";

export const DESCRIPTOR_WRITABLE_PROPERTY = "writable";

export const DESCRIPTOR_GET_PROPERTY = "get";

export const DESCRIPTOR_SET_PROPERTY = "set";

export const PATCH_REGISTRY_KEY = Symbol.for(PATCH_REGISTRY_SYMBOL_NAME);

export const LIFECYCLE_COORDINATOR_REGISTRY_KEY = Symbol.for(
	LIFECYCLE_COORDINATOR_REGISTRY_SYMBOL_NAME,
);

export const SHARED_PATCH_LEASE_REGISTRY_KEY = Symbol.for(SHARED_PATCH_LEASE_REGISTRY_SYMBOL_NAME);

export const TOOL_INSTALLER_TAG = Symbol.for(TOOL_INSTALLER_SYMBOL_NAME);

export const MAP_ENTRIES_METHOD = Map.prototype.entries;

export const WEAK_MAP_DELETE_PROPERTY = "delete";

export const WEAK_MAP_GET_PROPERTY = "get";

export const WEAK_MAP_HAS_PROPERTY = "has";

export const WEAK_MAP_SET_PROPERTY = "set";

export const WEAK_MAP_DELETE_METHOD = WeakMap.prototype.delete;

export const WEAK_MAP_GET_METHOD = WeakMap.prototype.get;

export const WEAK_MAP_HAS_METHOD = WeakMap.prototype.has;

export const WEAK_MAP_SET_METHOD = WeakMap.prototype.set;

export type LifecycleMethod = (this: object, ...args: unknown[]) => Promise<unknown>;

export type ToolSnapshot = {
	readonly name: string;
	readonly entry: PiRuntimeTool;
	readonly parameters: object;
	readonly prepareArguments: ((args: unknown) => unknown) | undefined;
	readonly executionMode: "parallel" | "sequential" | undefined;
	readonly execute: PiRuntimeTool["execute"];
};

export type RunnerEventMethod = (this: object, ...args: unknown[]) => Promise<unknown>;

export type BoundPiExtensionRunner = PiExtensionRunner & {
	emitToolCall: RunnerEventMethod;
	emitBeforeAgentStart: RunnerEventMethod;
};

export type RunnerEventProperty = (typeof RUNTIME_EVENT_PROPERTIES)[number];

export type RunnerEventMethodShape = {
	readonly property: RunnerEventProperty;
	readonly method: RunnerEventMethod;
	readonly descriptorOwner: object;
	readonly descriptor: PropertyDescriptor;
	readonly own: boolean;
};

export type RunnerEventMethodShapes = Record<RunnerEventProperty, RunnerEventMethodShape>;

export type SessionParts = {
	readonly extensionRunner: BoundPiExtensionRunner;
	readonly createContext: PiExtensionRunner["createContext"];
	readonly emit: PiExtensionRunner["emit"];
	readonly eventMethods: RunnerEventMethodShapes;
	readonly sharedRuntime: PiSharedRuntime;
	readonly getActiveTools: PiSharedRuntime["getActiveTools"];
	readonly setActiveTools: PiSharedRuntime["setActiveTools"];
	readonly refreshTools: PiSharedRuntime["refreshTools"];
	readonly toolRegistry: Map<string, PiRuntimeTool>;
	readonly toolSnapshots: readonly ToolSnapshot[];
	readonly getToolDefinition: (name: string) => unknown;
	readonly agent: object;
	readonly beforeToolCall: (...args: unknown[]) => Promise<unknown>;
	readonly afterToolCall: (...args: unknown[]) => Promise<unknown>;
};

export type LifecyclePatch = {
	property: string;
	originalDescriptor: PropertyDescriptor;
	originalFunction: LifecycleMethod;
	patchedFunction: LifecycleMethod;
};

export type LifecycleCoordinator = {
	slotBySession: WeakMap<object, LifecycleSlot>;
};

export type BindLifecycleInvocation = {
	kind: typeof BIND_INVOCATION_SLOT_KIND;
};

export type ReloadLifecycleInvocation = {
	kind: typeof RELOAD_INVOCATION_SLOT_KIND;
	retainedAssociation: SessionAssociation | undefined;
};

export type LifecycleInvocation = BindLifecycleInvocation | ReloadLifecycleInvocation;

export type SessionAssociation = {
	kind: typeof ASSOCIATION_SLOT_KIND;
	installer: PiRuntimeInstaller;
	definition: object;
	parts: SessionParts;
	toolGeneration: number;
	runtimeActionsInstalled: boolean;
	runtimeEventFinalizersInstalled: boolean;
};

export type LifecycleSlot = LifecycleInvocation | SessionAssociation;

export type PatchState = {
	active: boolean;
	installations: number;
	bindExtensions: LifecyclePatch;
	reload: LifecyclePatch;
	coordinator: LifecycleCoordinator;
};

export type LifecycleDescriptorValidation =
	| {
			compatible: true;
			descriptor: PropertyDescriptor;
			method: LifecycleMethod;
	  }
	| { compatible: false; diagnostic: string };

export type WeakMapEntry = { present: false } | { present: true; value: unknown };

export type RuntimeActionProperty = (typeof RUNTIME_ACTION_PROPERTIES)[number];

export type RuntimeActionDescriptors = Record<RuntimeActionProperty, PropertyDescriptor>;

export type ValidatedLifecycleCoordinator = {
	readonly coordinator: LifecycleCoordinator;
	readonly slotBySession: WeakMap<object, LifecycleSlot>;
};

export type ValidatedPatchState = {
	readonly state: PatchState;
	readonly installations: number;
	readonly bindExtensions: LifecyclePatch;
	readonly reload: LifecyclePatch;
};

export type SharedPatchLease = {
	readonly installation: Extract<PiRuntimePatchInstallation, { compatible: true }>;
	readonly state: PatchState;
	readonly coordinator: LifecycleCoordinator;
};

export class PiRuntimeCompatibilityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = COMPATIBILITY_ERROR_NAME;
	}
}

export function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

export function isRegistryRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null;
}

export function getOwnDataPropertyDescriptor(
	value: unknown,
	property: PropertyKey,
): PropertyDescriptor | undefined {
	if (!isRegistryRecord(value)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(value, property);
	return descriptor && Object.hasOwn(descriptor, DESCRIPTOR_VALUE_PROPERTY)
		? descriptor
		: undefined;
}

export function incompatible(
	message: string,
	transportOwnership?: PtcTransportOwnership,
): PiRuntimeCapture {
	return { compatible: false, diagnostic: message, transportOwnership };
}

export function isUsableWeakMap(value: unknown): value is WeakMap<object, unknown> {
	if (!isRegistryRecord(value)) return false;
	const probeKey = {};
	const probeValue = {};
	try {
		if (
			Reflect.get(value, WEAK_MAP_DELETE_PROPERTY) !== WEAK_MAP_DELETE_METHOD ||
			Reflect.get(value, WEAK_MAP_GET_PROPERTY) !== WEAK_MAP_GET_METHOD ||
			Reflect.get(value, WEAK_MAP_HAS_PROPERTY) !== WEAK_MAP_HAS_METHOD ||
			Reflect.get(value, WEAK_MAP_SET_PROPERTY) !== WEAK_MAP_SET_METHOD
		) {
			return false;
		}
		if (Reflect.apply(WEAK_MAP_HAS_METHOD, value, [probeKey]) !== false) return false;
		Reflect.apply(WEAK_MAP_SET_METHOD, value, [probeKey, probeValue]);
		if (Reflect.apply(WEAK_MAP_GET_METHOD, value, [probeKey]) !== probeValue) return false;
		return Reflect.apply(WEAK_MAP_DELETE_METHOD, value, [probeKey]) === true;
	} catch {
		return false;
	} finally {
		try {
			Reflect.apply(WEAK_MAP_DELETE_METHOD, value, [probeKey]);
		} catch {}
	}
}

export function getWeakMapEntry<TValue>(
	registry: WeakMap<object, TValue>,
	key: object,
): WeakMapEntry {
	if (Reflect.apply(WEAK_MAP_HAS_METHOD, registry, [key]) !== true) {
		return { present: false };
	}
	return {
		present: true,
		value: Reflect.apply(WEAK_MAP_GET_METHOD, registry, [key]),
	};
}

export function setWeakMapEntry<TValue>(
	registry: WeakMap<object, TValue>,
	key: object,
	value: TValue,
): void {
	Reflect.apply(WEAK_MAP_SET_METHOD, registry, [key, value]);
}

export function incompatibleGlobalRegistry(registryName: string): PiRuntimeCompatibilityError {
	return new PiRuntimeCompatibilityError(
		diagnostic(PI_RUNTIME_DIAGNOSTICS.GLOBAL_REGISTRY, `${registryName} entry is incompatible`),
	);
}

export function getGlobalRegistryDescriptor(
	globalObject: object,
	key: symbol,
	registryName: string,
): PropertyDescriptor | undefined {
	try {
		return Object.getOwnPropertyDescriptor(globalObject, key);
	} catch (error) {
		throw new PiRuntimeCompatibilityError(
			diagnostic(PI_RUNTIME_DIAGNOSTICS.GLOBAL_REGISTRY, `${registryName}: ${String(error)}`),
		);
	}
}

export function getGlobalRegistry<TValue>(
	globalObject: object,
	key: symbol,
	registryName: string,
): WeakMap<object, TValue> {
	const descriptor = getGlobalRegistryDescriptor(globalObject, key, registryName);
	if (descriptor !== undefined) {
		if (
			!Object.hasOwn(descriptor, DESCRIPTOR_VALUE_PROPERTY) ||
			!isUsableWeakMap(descriptor.value)
		) {
			throw incompatibleGlobalRegistry(registryName);
		}
		const confirmedDescriptor = getGlobalRegistryDescriptor(globalObject, key, registryName);
		if (
			!confirmedDescriptor ||
			!Object.hasOwn(confirmedDescriptor, DESCRIPTOR_VALUE_PROPERTY) ||
			confirmedDescriptor.value !== descriptor.value
		) {
			throw incompatibleGlobalRegistry(registryName);
		}
		return descriptor.value as WeakMap<object, TValue>;
	}
	const registry = new WeakMap<object, TValue>();
	try {
		Object.defineProperty(globalObject, key, {
			value: registry,
			configurable: true,
		});
	} catch (error) {
		throw new PiRuntimeCompatibilityError(
			diagnostic(PI_RUNTIME_DIAGNOSTICS.GLOBAL_REGISTRY, `${registryName}: ${String(error)}`),
		);
	}
	const definedDescriptor = getGlobalRegistryDescriptor(globalObject, key, registryName);
	if (
		!definedDescriptor ||
		!Object.hasOwn(definedDescriptor, DESCRIPTOR_VALUE_PROPERTY) ||
		definedDescriptor.value !== registry ||
		!isUsableWeakMap(definedDescriptor.value)
	) {
		throw incompatibleGlobalRegistry(registryName);
	}
	return registry;
}

export function getPatchRegistry(globalObject: object): WeakMap<object, PatchState> {
	return getGlobalRegistry(globalObject, PATCH_REGISTRY_KEY, PATCH_REGISTRY_SYMBOL_NAME);
}

export function getLifecycleCoordinatorRegistry(
	globalObject: object,
): WeakMap<object, LifecycleCoordinator> {
	return getGlobalRegistry(
		globalObject,
		LIFECYCLE_COORDINATOR_REGISTRY_KEY,
		LIFECYCLE_COORDINATOR_REGISTRY_SYMBOL_NAME,
	);
}

export function getSharedPatchLeaseRegistry(
	globalObject: object,
): WeakMap<object, SharedPatchLease> {
	return getGlobalRegistry(
		globalObject,
		SHARED_PATCH_LEASE_REGISTRY_KEY,
		SHARED_PATCH_LEASE_REGISTRY_SYMBOL_NAME,
	);
}
