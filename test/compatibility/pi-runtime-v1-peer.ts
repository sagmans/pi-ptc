const PATCH_REGISTRY_SYMBOL_NAME = "pi-ptc.pi-runtime.patch-registry.v1";
const LIFECYCLE_COORDINATOR_REGISTRY_SYMBOL_NAME =
	"pi-ptc.pi-runtime.lifecycle-coordinator-registry.v1";
const SHARED_PATCH_LEASE_REGISTRY_SYMBOL_NAME = "pi-ptc.pi-runtime.shared-patch-lease-registry.v1";
const TOOL_INSTALLER_SYMBOL_NAME = "pi-ptc.pi-runtime.installer.v1";
const BIND_EXTENSIONS_PROPERTY = "bindExtensions";
const RELOAD_PROPERTY = "reload";
const SLOT_BY_SESSION_PROPERTY = "slotBySession";

export const PI_RUNTIME_V1_SYMBOL_NAMES = Object.freeze({
	patchRegistry: PATCH_REGISTRY_SYMBOL_NAME,
	lifecycleCoordinatorRegistry: LIFECYCLE_COORDINATOR_REGISTRY_SYMBOL_NAME,
	sharedPatchLeaseRegistry: SHARED_PATCH_LEASE_REGISTRY_SYMBOL_NAME,
	toolInstaller: TOOL_INSTALLER_SYMBOL_NAME,
});

export type PiRuntimeV1PeerSnapshot = {
	readonly lifecycleDescriptors: ReadonlyMap<string, PropertyDescriptor | undefined>;
	readonly registryDescriptors: ReadonlyMap<string, PropertyDescriptor | undefined>;
};

function copyDescriptor(
	descriptor: PropertyDescriptor | undefined,
): PropertyDescriptor | undefined {
	return descriptor === undefined ? undefined : Object.freeze({ ...descriptor });
}

export function snapshotPiRuntimeV1Peer(
	globalObject: object,
	agentSessionPrototype: object,
): PiRuntimeV1PeerSnapshot {
	const lifecycleDescriptors = new Map<string, PropertyDescriptor | undefined>([
		[
			BIND_EXTENSIONS_PROPERTY,
			copyDescriptor(
				Object.getOwnPropertyDescriptor(agentSessionPrototype, BIND_EXTENSIONS_PROPERTY),
			),
		],
		[
			RELOAD_PROPERTY,
			copyDescriptor(Object.getOwnPropertyDescriptor(agentSessionPrototype, RELOAD_PROPERTY)),
		],
	]);
	const registryDescriptors = new Map<string, PropertyDescriptor | undefined>();
	for (const symbolName of Object.values(PI_RUNTIME_V1_SYMBOL_NAMES)) {
		registryDescriptors.set(
			symbolName,
			copyDescriptor(Object.getOwnPropertyDescriptor(globalObject, Symbol.for(symbolName))),
		);
	}
	return Object.freeze({ lifecycleDescriptors, registryDescriptors });
}

export function readPiRuntimeV1Registry(
	globalObject: object,
	name: keyof Pick<
		typeof PI_RUNTIME_V1_SYMBOL_NAMES,
		"patchRegistry" | "lifecycleCoordinatorRegistry" | "sharedPatchLeaseRegistry"
	>,
): WeakMap<object, unknown> | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(
		globalObject,
		Symbol.for(PI_RUNTIME_V1_SYMBOL_NAMES[name]),
	);
	return descriptor && Object.hasOwn(descriptor, "value") && descriptor.value instanceof WeakMap
		? descriptor.value
		: undefined;
}

export function hasPiRuntimeV1CoordinatorShape(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const descriptor = Object.getOwnPropertyDescriptor(value, SLOT_BY_SESSION_PROPERTY);
	return (
		descriptor !== undefined &&
		Object.hasOwn(descriptor, "value") &&
		descriptor.value instanceof WeakMap
	);
}
