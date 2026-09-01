import type {
	PiExtensionRunner,
	PiRuntimeCapture,
	PiRuntimePatchInstallation,
	PiRuntimeTool,
	PiSharedRuntime,
	PtcTransportOwnership,
} from "./pi-runtime-contract.ts";
import { diagnostic, PI_RUNTIME_DIAGNOSTICS } from "./pi-runtime-contract.ts";
import {
	type ASSOCIATION_SLOT_KIND,
	type BIND_INVOCATION_SLOT_KIND,
	COMPATIBILITY_ERROR_NAME,
	DESCRIPTOR_VALUE_PROPERTY,
	LIFECYCLE_COORDINATOR_REGISTRY_KEY,
	LIFECYCLE_COORDINATOR_REGISTRY_SYMBOL_NAME,
	PATCH_REGISTRY_KEY,
	PATCH_REGISTRY_SYMBOL_NAME,
	type RELOAD_INVOCATION_SLOT_KIND,
	type RUNTIME_ACTION_PROPERTIES,
	type RUNTIME_EVENT_PROPERTIES,
	SHARED_PATCH_LEASE_REGISTRY_KEY,
	SHARED_PATCH_LEASE_REGISTRY_SYMBOL_NAME,
	WEAK_MAP_DELETE_METHOD,
	WEAK_MAP_DELETE_PROPERTY,
	WEAK_MAP_GET_METHOD,
	WEAK_MAP_GET_PROPERTY,
	WEAK_MAP_HAS_METHOD,
	WEAK_MAP_HAS_PROPERTY,
	WEAK_MAP_SET_METHOD,
	WEAK_MAP_SET_PROPERTY,
} from "./pi-runtime-properties.ts";

export * from "./pi-runtime-properties.ts";

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
	retainedAssociation: object | undefined;
};

export type LifecycleInvocation = BindLifecycleInvocation | ReloadLifecycleInvocation;

export type LifecycleSlot = LifecycleInvocation | { readonly kind: typeof ASSOCIATION_SLOT_KIND };

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
