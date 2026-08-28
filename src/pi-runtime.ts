import { AgentSession, VERSION } from "@earendil-works/pi-coding-agent";

export const SUPPORTED_PI_VERSION = "0.84.3";
export const PI_RUNTIME_PRIVATE_PROPERTIES = Object.freeze({
	TOOL_REGISTRY: "_toolRegistry",
	RUNNER_RUNTIME: "runtime",
});
export const PI_RUNTIME_DIAGNOSTICS = Object.freeze({
	UNSUPPORTED_VERSION: "Unsupported Pi runtime version",
	MISSING_BIND_EXTENSIONS: "AgentSession.prototype.bindExtensions is unavailable",
	UNPATCHABLE_BIND_EXTENSIONS: "AgentSession.prototype.bindExtensions is not patchable",
	MISSING_RELOAD: "AgentSession.prototype.reload is unavailable",
	UNPATCHABLE_RELOAD: "AgentSession.prototype.reload is not patchable",
	PATCH_CONFLICT: "AgentSession lifecycle methods changed after pi-ptc patched them",
	PATCH_FAILED: "AgentSession lifecycle methods could not be patched",
	INVALID_INSTALLER: "Pi runtime installer must implement capturePiRuntime",
	MISSING_TOOL_LOOKUP: "Bound AgentSession.getToolDefinition is unavailable",
	MISSING_EXTENSION_RUNNER: "Bound AgentSession.extensionRunner is unavailable",
	MISSING_CREATE_CONTEXT: "Bound extensionRunner.createContext is unavailable",
	MISSING_EMIT: "Bound extensionRunner.emit is unavailable",
	MISSING_EMIT_TOOL_CALL: "Bound extensionRunner.emitToolCall is unavailable",
	UNPATCHABLE_EMIT_TOOL_CALL: "Bound extensionRunner.emitToolCall is not patchable",
	MISSING_EMIT_BEFORE_AGENT_START: "Bound extensionRunner.emitBeforeAgentStart is unavailable",
	UNPATCHABLE_EMIT_BEFORE_AGENT_START:
		"Bound extensionRunner.emitBeforeAgentStart is not patchable",
	MISSING_RUNNER_RUNTIME: "Bound extensionRunner runtime is unavailable",
	MISSING_GET_ACTIVE_TOOLS: "Bound extension runtime getActiveTools is unavailable",
	MISSING_SET_ACTIVE_TOOLS: "Bound extension runtime setActiveTools is unavailable",
	MISSING_REFRESH_TOOLS: "Bound extension runtime refreshTools is unavailable",
	INVALID_RUNTIME_ACTION_REPLACEMENTS: "Pi runtime action replacements are invalid",
	UNPATCHABLE_RUNTIME_ACTIONS: "Bound extension runtime actions are not patchable",
	RUNTIME_ACTION_PATCH_FAILED: "Bound extension runtime actions could not be replaced",
	RUNTIME_ACTIONS_ALREADY_INSTALLED: "Pi runtime actions are already virtualized",
	INVALID_RUNTIME_EVENT_FINALIZERS: "Pi runtime event finalizers are invalid",
	RUNTIME_EVENT_FINALIZERS_ALREADY_INSTALLED: "Pi runtime event finalizers are already installed",
	RUNTIME_EVENT_FINALIZER_PATCH_FAILED:
		"Bound extension runner event finalizers could not be installed",
	MISSING_TOOL_REGISTRY: "Bound AgentSession._toolRegistry is unavailable",
	INVALID_TOOL_NAME: "Bound tool registry contains an invalid name",
	MISSING_TOOL_PARAMETERS: "Bound tool registry entry parameters are unavailable",
	INVALID_PREPARE_ARGUMENTS: "Bound tool registry entry prepareArguments is invalid",
	INVALID_EXECUTION_MODE: "Bound tool registry entry executionMode is invalid",
	MISSING_TOOL_EXECUTE: "Bound tool registry entry execute is unavailable",
	MISSING_AGENT: "Bound AgentSession.agent is unavailable",
	MISSING_BEFORE_TOOL_CALL: "Bound agent.beforeToolCall hook is unavailable",
	MISSING_AFTER_TOOL_CALL: "Bound agent.afterToolCall hook is unavailable",
	GLOBAL_REGISTRY: "Pi runtime global registry is unavailable",
	STALE_CAPTURE: "Captured Pi runtime session is no longer associated with this installer",
} as const);

const BIND_EXTENSIONS_PROPERTY = "bindExtensions";
const RELOAD_PROPERTY = "reload";
const EXTENSION_RUNNER_PROPERTY = "extensionRunner";
const GET_TOOL_DEFINITION_PROPERTY = "getToolDefinition";
const AGENT_PROPERTY = "agent";
const BEFORE_TOOL_CALL_PROPERTY = "beforeToolCall";
const AFTER_TOOL_CALL_PROPERTY = "afterToolCall";
const CREATE_CONTEXT_PROPERTY = "createContext";
const EMIT_PROPERTY = "emit";
const EMIT_TOOL_CALL_PROPERTY = "emitToolCall";
const EMIT_BEFORE_AGENT_START_PROPERTY = "emitBeforeAgentStart";
const GET_ACTIVE_TOOLS_PROPERTY = "getActiveTools";
const SET_ACTIVE_TOOLS_PROPERTY = "setActiveTools";
const REFRESH_TOOLS_PROPERTY = "refreshTools";
const PARAMETERS_PROPERTY = "parameters";
const PREPARE_ARGUMENTS_PROPERTY = "prepareArguments";
const EXECUTION_MODE_PROPERTY = "executionMode";
const EXECUTE_PROPERTY = "execute";
const PTC_TOOL_NAME = "ptc";
const RUNTIME_ACTION_PROPERTIES = Object.freeze([
	GET_ACTIVE_TOOLS_PROPERTY,
	SET_ACTIVE_TOOLS_PROPERTY,
	REFRESH_TOOLS_PROPERTY,
] as const);
const RUNTIME_EVENT_PROPERTIES = Object.freeze([
	EMIT_TOOL_CALL_PROPERTY,
	EMIT_BEFORE_AGENT_START_PROPERTY,
] as const);
const FINALIZE_TOOL_CALL_PROPERTY = "finalizeToolCall";
const FINALIZE_BEFORE_AGENT_START_PROPERTY = "finalizeBeforeAgentStart";
const RESTORE_INHERITED_EVENT_METHOD_ERROR_PREFIX = "Could not restore inherited";
const PARALLEL_EXECUTION_MODE = "parallel";
const SEQUENTIAL_EXECUTION_MODE = "sequential";
const PATCH_REGISTRY_SYMBOL_NAME = "pi-ptc.pi-runtime.patch-registry.v1";
const LIFECYCLE_COORDINATOR_REGISTRY_SYMBOL_NAME =
	"pi-ptc.pi-runtime.lifecycle-coordinator-registry.v1";
const SHARED_PATCH_LEASE_REGISTRY_SYMBOL_NAME = "pi-ptc.pi-runtime.shared-patch-lease-registry.v1";
const TOOL_INSTALLER_SYMBOL_NAME = "pi-ptc.pi-runtime.installer.v1";
const COMPATIBILITY_ERROR_NAME = "PiRuntimeCompatibilityError";
const BIND_INVOCATION_SLOT_KIND = "bind-invocation";
const RELOAD_INVOCATION_SLOT_KIND = "reload-invocation";
const ASSOCIATION_SLOT_KIND = "association";
const SLOT_BY_SESSION_PROPERTY = "slotBySession";
const ACTIVE_PROPERTY = "active";
const INSTALLATIONS_PROPERTY = "installations";
const BIND_EXTENSIONS_PATCH_PROPERTY = "bindExtensions";
const RELOAD_PATCH_PROPERTY = "reload";
const COORDINATOR_PROPERTY = "coordinator";
const INSTALLATION_PROPERTY = "installation";
const STATE_PROPERTY = "state";
const COMPATIBLE_PROPERTY = "compatible";
const TEARDOWN_PROPERTY = "teardown";
const PATCH_PROPERTY_PROPERTY = "property";
const ORIGINAL_DESCRIPTOR_PROPERTY = "originalDescriptor";
const ORIGINAL_FUNCTION_PROPERTY = "originalFunction";
const PATCHED_FUNCTION_PROPERTY = "patchedFunction";
const DESCRIPTOR_VALUE_PROPERTY = "value";
const DESCRIPTOR_CONFIGURABLE_PROPERTY = "configurable";
const DESCRIPTOR_ENUMERABLE_PROPERTY = "enumerable";
const DESCRIPTOR_WRITABLE_PROPERTY = "writable";
const DESCRIPTOR_GET_PROPERTY = "get";
const DESCRIPTOR_SET_PROPERTY = "set";
const PATCH_REGISTRY_KEY = Symbol.for(PATCH_REGISTRY_SYMBOL_NAME);
const LIFECYCLE_COORDINATOR_REGISTRY_KEY = Symbol.for(LIFECYCLE_COORDINATOR_REGISTRY_SYMBOL_NAME);
const SHARED_PATCH_LEASE_REGISTRY_KEY = Symbol.for(SHARED_PATCH_LEASE_REGISTRY_SYMBOL_NAME);
const TOOL_INSTALLER_TAG = Symbol.for(TOOL_INSTALLER_SYMBOL_NAME);
const MAP_ENTRIES_METHOD = Map.prototype.entries;
const WEAK_MAP_DELETE_PROPERTY = "delete";
const WEAK_MAP_GET_PROPERTY = "get";
const WEAK_MAP_HAS_PROPERTY = "has";
const WEAK_MAP_SET_PROPERTY = "set";
const WEAK_MAP_DELETE_METHOD = WeakMap.prototype.delete;
const WEAK_MAP_GET_METHOD = WeakMap.prototype.get;
const WEAK_MAP_HAS_METHOD = WeakMap.prototype.has;
const WEAK_MAP_SET_METHOD = WeakMap.prototype.set;

export type PiRuntimeTool = {
	parameters: object;
	prepareArguments?: (args: unknown) => unknown;
	executionMode?: "parallel" | "sequential";
	execute(
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: (partialResult: unknown) => void,
	): Promise<unknown>;
};

export type PiExtensionRunner = {
	createContext(): unknown;
	emit(event: unknown): Promise<unknown>;
};

export type PiRuntimeEventFinalizer = (
	args: readonly unknown[],
	result: unknown,
	context: unknown,
) => Promise<unknown> | unknown;

export type PiRuntimeEventFinalizers = {
	finalizeToolCall: PiRuntimeEventFinalizer;
	finalizeBeforeAgentStart: PiRuntimeEventFinalizer;
};

export type PiRuntimeEventFinalizersInstallation = {
	restore(): void;
};

export type PiSharedRuntime = {
	getActiveTools(): string[];
	setActiveTools(toolNames: string[]): void;
	refreshTools(): void;
};

export type PiRuntimeToolEntry = {
	readonly name: string;
	readonly executable: PiRuntimeTool;
	readonly definition: unknown;
};

export type PiRuntimeOriginalActions = {
	getActiveTools(): string[];
	setActiveTools(toolNames: string[]): void;
	refreshTools(): void;
	snapshotTools(): readonly PiRuntimeToolEntry[];
};

export type PiRuntimeActionsInstallation = {
	readonly original: PiRuntimeOriginalActions;
	restore(activeToolNames?: readonly string[]): void;
};

export type CapturedPiSession = {
	readonly version: typeof SUPPORTED_PI_VERSION;
	readonly extensionRunner: PiExtensionRunner;
	readonly sharedRuntime: PiSharedRuntime;
	readonly toolRegistry: ReadonlyMap<string, PiRuntimeTool>;
	readonly beforeToolCall: (...args: unknown[]) => Promise<unknown>;
	readonly afterToolCall: (...args: unknown[]) => Promise<unknown>;
	getToolDefinition(name: string): unknown;
	installRuntimeActions(replacements: PiSharedRuntime): PiRuntimeActionsInstallation;
	installRuntimeEventFinalizers(
		finalizers: PiRuntimeEventFinalizers,
	): PiRuntimeEventFinalizersInstallation;
};

export type PiRuntimeCapture =
	| { compatible: true; session: CapturedPiSession }
	| { compatible: false; diagnostic: string };

export type PiRuntimeInstaller = {
	capturePiRuntime(capture: PiRuntimeCapture): void;
};

export type PiRuntimePatchOptions = {
	agentSession?: { prototype: object };
	version?: string;
	globalObject?: object;
};

export type PiRuntimePatchInstallation =
	| { compatible: true; teardown: () => void }
	| { compatible: false; diagnostic: string };

export type PiRuntimeSharedPatchEnsure =
	| { compatible: true }
	| { compatible: false; diagnostic: string };

type LifecycleMethod = (this: object, ...args: unknown[]) => Promise<unknown>;

type ToolSnapshot = {
	readonly name: string;
	readonly entry: PiRuntimeTool;
	readonly parameters: object;
	readonly prepareArguments: ((args: unknown) => unknown) | undefined;
	readonly executionMode: "parallel" | "sequential" | undefined;
	readonly execute: PiRuntimeTool["execute"];
};

type RunnerEventMethod = (this: object, ...args: unknown[]) => Promise<unknown>;

type BoundPiExtensionRunner = PiExtensionRunner & {
	emitToolCall: RunnerEventMethod;
	emitBeforeAgentStart: RunnerEventMethod;
};

type RunnerEventProperty = (typeof RUNTIME_EVENT_PROPERTIES)[number];

type RunnerEventMethodShape = {
	readonly property: RunnerEventProperty;
	readonly method: RunnerEventMethod;
	readonly descriptorOwner: object;
	readonly descriptor: PropertyDescriptor;
	readonly own: boolean;
};

type RunnerEventMethodShapes = Record<RunnerEventProperty, RunnerEventMethodShape>;

type SessionParts = {
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

type LifecyclePatch = {
	property: string;
	originalDescriptor: PropertyDescriptor;
	originalFunction: LifecycleMethod;
	patchedFunction: LifecycleMethod;
};

type LifecycleCoordinator = {
	slotBySession: WeakMap<object, LifecycleSlot>;
};

type BindLifecycleInvocation = {
	kind: typeof BIND_INVOCATION_SLOT_KIND;
};

type ReloadLifecycleInvocation = {
	kind: typeof RELOAD_INVOCATION_SLOT_KIND;
	retainedAssociation: SessionAssociation | undefined;
};

type LifecycleInvocation = BindLifecycleInvocation | ReloadLifecycleInvocation;

type SessionAssociation = {
	kind: typeof ASSOCIATION_SLOT_KIND;
	installer: PiRuntimeInstaller;
	definition: object;
	parts: SessionParts;
	toolGeneration: number;
	runtimeActionsInstalled: boolean;
	runtimeEventFinalizersInstalled: boolean;
};

type LifecycleSlot = LifecycleInvocation | SessionAssociation;

type PatchState = {
	active: boolean;
	installations: number;
	bindExtensions: LifecyclePatch;
	reload: LifecyclePatch;
	coordinator: LifecycleCoordinator;
};

type LifecycleDescriptorValidation =
	| {
			compatible: true;
			descriptor: PropertyDescriptor;
			method: LifecycleMethod;
	  }
	| { compatible: false; diagnostic: string };

type WeakMapEntry = { present: false } | { present: true; value: unknown };

type RuntimeActionProperty = (typeof RUNTIME_ACTION_PROPERTIES)[number];
type RuntimeActionDescriptors = Record<RuntimeActionProperty, PropertyDescriptor>;

type ValidatedLifecycleCoordinator = {
	readonly coordinator: LifecycleCoordinator;
	readonly slotBySession: WeakMap<object, LifecycleSlot>;
};

type ValidatedPatchState = {
	readonly state: PatchState;
	readonly installations: number;
	readonly bindExtensions: LifecyclePatch;
	readonly reload: LifecyclePatch;
};

type SharedPatchLease = {
	readonly installation: Extract<PiRuntimePatchInstallation, { compatible: true }>;
	readonly state: PatchState;
	readonly coordinator: LifecycleCoordinator;
};

class PiRuntimeCompatibilityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = COMPATIBILITY_ERROR_NAME;
	}
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isRegistryRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null;
}

function getOwnDataPropertyDescriptor(
	value: unknown,
	property: PropertyKey,
): PropertyDescriptor | undefined {
	if (!isRegistryRecord(value)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(value, property);
	return descriptor && Object.hasOwn(descriptor, DESCRIPTOR_VALUE_PROPERTY)
		? descriptor
		: undefined;
}

function diagnostic(prefix: string, detail?: string): string {
	return detail ? `${prefix}: ${detail}` : prefix;
}

export function getPiRuntimeVersionDiagnostic(
	importedVersion: string,
	suppliedVersion?: string,
): string | undefined {
	if (importedVersion !== SUPPORTED_PI_VERSION) {
		return diagnostic(
			PI_RUNTIME_DIAGNOSTICS.UNSUPPORTED_VERSION,
			`expected ${SUPPORTED_PI_VERSION}, imported ${importedVersion}`,
		);
	}
	if (suppliedVersion !== undefined && suppliedVersion !== importedVersion) {
		return diagnostic(
			PI_RUNTIME_DIAGNOSTICS.UNSUPPORTED_VERSION,
			`imported ${importedVersion}, supplied ${suppliedVersion}`,
		);
	}
	return undefined;
}

function incompatible(message: string): PiRuntimeCapture {
	return { compatible: false, diagnostic: message };
}

function isUsableWeakMap(value: unknown): value is WeakMap<object, unknown> {
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

function getWeakMapEntry<TValue>(registry: WeakMap<object, TValue>, key: object): WeakMapEntry {
	if (Reflect.apply(WEAK_MAP_HAS_METHOD, registry, [key]) !== true) {
		return { present: false };
	}
	return {
		present: true,
		value: Reflect.apply(WEAK_MAP_GET_METHOD, registry, [key]),
	};
}

function setWeakMapEntry<TValue>(
	registry: WeakMap<object, TValue>,
	key: object,
	value: TValue,
): void {
	Reflect.apply(WEAK_MAP_SET_METHOD, registry, [key, value]);
}

function incompatibleGlobalRegistry(registryName: string): PiRuntimeCompatibilityError {
	return new PiRuntimeCompatibilityError(
		diagnostic(PI_RUNTIME_DIAGNOSTICS.GLOBAL_REGISTRY, `${registryName} entry is incompatible`),
	);
}

function getGlobalRegistryDescriptor(
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

function getGlobalRegistry<TValue>(
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

function getPatchRegistry(globalObject: object): WeakMap<object, PatchState> {
	return getGlobalRegistry(globalObject, PATCH_REGISTRY_KEY, PATCH_REGISTRY_SYMBOL_NAME);
}

function getLifecycleCoordinatorRegistry(
	globalObject: object,
): WeakMap<object, LifecycleCoordinator> {
	return getGlobalRegistry(
		globalObject,
		LIFECYCLE_COORDINATOR_REGISTRY_KEY,
		LIFECYCLE_COORDINATOR_REGISTRY_SYMBOL_NAME,
	);
}

function getSharedPatchLeaseRegistry(globalObject: object): WeakMap<object, SharedPatchLease> {
	return getGlobalRegistry(
		globalObject,
		SHARED_PATCH_LEASE_REGISTRY_KEY,
		SHARED_PATCH_LEASE_REGISTRY_SYMBOL_NAME,
	);
}

function validateLifecycleCoordinator(value: unknown): ValidatedLifecycleCoordinator | undefined {
	const slotDescriptor = getOwnDataPropertyDescriptor(value, SLOT_BY_SESSION_PROPERTY);
	if (!slotDescriptor || !isUsableWeakMap(slotDescriptor.value)) return undefined;
	return {
		coordinator: value as LifecycleCoordinator,
		slotBySession: slotDescriptor.value as WeakMap<object, LifecycleSlot>,
	};
}

function validateStoredLifecycleDescriptor(
	value: unknown,
	originalFunction: LifecycleMethod,
): PropertyDescriptor | undefined {
	const valueDescriptor = getOwnDataPropertyDescriptor(value, DESCRIPTOR_VALUE_PROPERTY);
	const configurableDescriptor = getOwnDataPropertyDescriptor(
		value,
		DESCRIPTOR_CONFIGURABLE_PROPERTY,
	);
	const enumerableDescriptor = getOwnDataPropertyDescriptor(value, DESCRIPTOR_ENUMERABLE_PROPERTY);
	const writableDescriptor = getOwnDataPropertyDescriptor(value, DESCRIPTOR_WRITABLE_PROPERTY);
	if (
		!valueDescriptor ||
		!configurableDescriptor ||
		!enumerableDescriptor ||
		!writableDescriptor ||
		valueDescriptor.value !== originalFunction ||
		typeof configurableDescriptor.value !== "boolean" ||
		typeof enumerableDescriptor.value !== "boolean" ||
		typeof writableDescriptor.value !== "boolean" ||
		(!configurableDescriptor.value && !writableDescriptor.value) ||
		Reflect.has(value as object, DESCRIPTOR_GET_PROPERTY) ||
		Reflect.has(value as object, DESCRIPTOR_SET_PROPERTY)
	) {
		return undefined;
	}
	return {
		value: originalFunction,
		configurable: configurableDescriptor.value,
		enumerable: enumerableDescriptor.value,
		writable: writableDescriptor.value,
	};
}

function validateLifecyclePatch(
	value: unknown,
	expectedProperty: string,
): LifecyclePatch | undefined {
	const propertyDescriptor = getOwnDataPropertyDescriptor(value, PATCH_PROPERTY_PROPERTY);
	const originalDescriptorDescriptor = getOwnDataPropertyDescriptor(
		value,
		ORIGINAL_DESCRIPTOR_PROPERTY,
	);
	const originalFunctionDescriptor = getOwnDataPropertyDescriptor(
		value,
		ORIGINAL_FUNCTION_PROPERTY,
	);
	const patchedFunctionDescriptor = getOwnDataPropertyDescriptor(value, PATCHED_FUNCTION_PROPERTY);
	const originalFunction = originalFunctionDescriptor?.value;
	const patchedFunction = patchedFunctionDescriptor?.value;
	if (
		propertyDescriptor?.value !== expectedProperty ||
		!originalDescriptorDescriptor ||
		typeof originalFunction !== "function" ||
		typeof patchedFunction !== "function" ||
		originalFunction === patchedFunction
	) {
		return undefined;
	}
	const originalDescriptor = validateStoredLifecycleDescriptor(
		originalDescriptorDescriptor.value,
		originalFunction as LifecycleMethod,
	);
	if (!originalDescriptor) return undefined;
	return {
		property: expectedProperty,
		originalDescriptor,
		originalFunction: originalFunction as LifecycleMethod,
		patchedFunction: patchedFunction as LifecycleMethod,
	};
}

function validatePatchState(
	value: unknown,
	coordinator: LifecycleCoordinator,
): ValidatedPatchState | undefined {
	const activeDescriptor = getOwnDataPropertyDescriptor(value, ACTIVE_PROPERTY);
	const installationsDescriptor = getOwnDataPropertyDescriptor(value, INSTALLATIONS_PROPERTY);
	const bindExtensionsDescriptor = getOwnDataPropertyDescriptor(
		value,
		BIND_EXTENSIONS_PATCH_PROPERTY,
	);
	const reloadDescriptor = getOwnDataPropertyDescriptor(value, RELOAD_PATCH_PROPERTY);
	const coordinatorDescriptor = getOwnDataPropertyDescriptor(value, COORDINATOR_PROPERTY);
	const installations = installationsDescriptor?.value;
	if (
		activeDescriptor?.value !== true ||
		activeDescriptor.writable !== true ||
		!Number.isSafeInteger(installations) ||
		(installations as number) <= 0 ||
		installationsDescriptor?.writable !== true ||
		!bindExtensionsDescriptor ||
		!reloadDescriptor ||
		coordinatorDescriptor?.value !== coordinator
	) {
		return undefined;
	}
	const bindExtensions = validateLifecyclePatch(
		bindExtensionsDescriptor.value,
		BIND_EXTENSIONS_PROPERTY,
	);
	const reload = validateLifecyclePatch(reloadDescriptor.value, RELOAD_PROPERTY);
	if (!bindExtensions || !reload) return undefined;
	return {
		state: value as PatchState,
		installations: installations as number,
		bindExtensions,
		reload,
	};
}

function validateSharedPatchLease(
	value: unknown,
	state: PatchState,
	coordinator: LifecycleCoordinator,
): SharedPatchLease | undefined {
	const installationDescriptor = getOwnDataPropertyDescriptor(value, INSTALLATION_PROPERTY);
	const stateDescriptor = getOwnDataPropertyDescriptor(value, STATE_PROPERTY);
	const coordinatorDescriptor = getOwnDataPropertyDescriptor(value, COORDINATOR_PROPERTY);
	const installation = installationDescriptor?.value;
	if (
		stateDescriptor?.value !== state ||
		coordinatorDescriptor?.value !== coordinator ||
		!isRegistryRecord(installation) ||
		getOwnDataPropertyDescriptor(installation, COMPATIBLE_PROPERTY)?.value !== true ||
		typeof getOwnDataPropertyDescriptor(installation, TEARDOWN_PROPERTY)?.value !== "function"
	) {
		return undefined;
	}
	return value as SharedPatchLease;
}

function getTaggedInstaller(definition: unknown): PiRuntimeInstaller | undefined {
	if (!isRecord(definition)) return undefined;
	const installer = definition[TOOL_INSTALLER_TAG];
	if (!isRecord(installer)) return undefined;
	return typeof installer.capturePiRuntime === "function"
		? (installer as PiRuntimeInstaller)
		: undefined;
}

function validateToolRegistry(registry: unknown):
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

function dataDescriptorsMatch(
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

function validateRunnerEventMethod(
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

function runnerEventShapesMatch(
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

function validateSession(
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

function clearCurrentSlot(
	slotBySession: WeakMap<object, LifecycleSlot>,
	session: object,
	expectedSlot: LifecycleSlot,
): void {
	const currentSlot = slotBySession.get(session);
	if (currentSlot === expectedSlot) {
		slotBySession.delete(session);
		return;
	}
	if (
		expectedSlot.kind === ASSOCIATION_SLOT_KIND &&
		currentSlot?.kind === RELOAD_INVOCATION_SLOT_KIND &&
		currentSlot.retainedAssociation === expectedSlot
	) {
		currentSlot.retainedAssociation = undefined;
	}
}

function invocationOwnsSlotAtSettlement(
	slotBySession: WeakMap<object, LifecycleSlot>,
	session: object,
	invocation: LifecycleInvocation,
): boolean {
	const currentSlot = slotBySession.get(session);
	if (currentSlot === invocation) {
		if (invocation.kind === RELOAD_INVOCATION_SLOT_KIND) {
			invocation.retainedAssociation = undefined;
		}
		return true;
	}
	if (currentSlot?.kind === ASSOCIATION_SLOT_KIND) {
		slotBySession.delete(session);
	}
	return false;
}

function throwStaleCapture(
	_state: PatchState,
	slotBySession: WeakMap<object, LifecycleSlot>,
	session: object,
	association: SessionAssociation,
): never {
	clearCurrentSlot(slotBySession, session, association);
	throw new PiRuntimeCompatibilityError(PI_RUNTIME_DIAGNOSTICS.STALE_CAPTURE);
}

function toolSnapshotsMatch(
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

function sessionPartsMatch(current: SessionParts, expected: SessionParts): boolean {
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

function sessionPartsMatchWithRuntimeActions(
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

function sessionPartsMatchAfterToolRefresh(
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

function validateRuntimeActionReplacements(value: unknown): value is PiSharedRuntime {
	if (!isRecord(value)) return false;
	return RUNTIME_ACTION_PROPERTIES.every((property) => typeof value[property] === "function");
}

function validateRuntimeEventFinalizers(value: unknown): value is PiRuntimeEventFinalizers {
	return (
		isRecord(value) &&
		typeof value[FINALIZE_TOOL_CALL_PROPERTY] === "function" &&
		typeof value[FINALIZE_BEFORE_AGENT_START_PROPERTY] === "function"
	);
}

function runnerEventWrappersMatch(
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

function sessionPartsMatchWithRuntimeEventFinalizers(
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

function inheritedRunnerEventSourcesMatch(shapes: RunnerEventMethodShapes): boolean {
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

function getRuntimeActionDescriptors(
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

function requireCurrentSessionParts(
	state: PatchState,
	slotBySession: WeakMap<object, LifecycleSlot>,
	session: object,
	association: SessionAssociation,
): SessionParts {
	const currentSlot = slotBySession.get(session);
	const associationIsCurrent =
		currentSlot === association ||
		(currentSlot?.kind === RELOAD_INVOCATION_SLOT_KIND &&
			currentSlot.retainedAssociation === association);
	if (!state.active || !associationIsCurrent) {
		throwStaleCapture(state, slotBySession, session, association);
	}
	let validation: ReturnType<typeof validateSession>;
	try {
		validation = validateSession(session);
	} catch {
		throwStaleCapture(state, slotBySession, session, association);
	}
	if (!validation.compatible || !sessionPartsMatch(validation.parts, association.parts)) {
		throwStaleCapture(state, slotBySession, session, association);
	}
	const expectedParts = association.parts;
	let definition: unknown;
	try {
		definition = Reflect.apply(expectedParts.getToolDefinition, session, [PTC_TOOL_NAME]);
	} catch {
		throwStaleCapture(state, slotBySession, session, association);
	}
	if (
		definition !== association.definition ||
		getTaggedInstaller(definition) !== association.installer
	) {
		throwStaleCapture(state, slotBySession, session, association);
	}
	return expectedParts;
}

function createGuardedIterator<T>(
	validate: () => SessionParts,
	length: number,
	valueAt: (index: number) => T,
): IterableIterator<T> {
	let index = 0;
	const iterator: IterableIterator<T> = {
		next(): IteratorResult<T> {
			validate();
			if (index >= length) return { done: true, value: undefined };
			const value = valueAt(index);
			index += 1;
			return { done: false, value };
		},
		[Symbol.iterator](): IterableIterator<T> {
			validate();
			return iterator;
		},
	};
	return Object.freeze(iterator);
}

function createToolFacade(validate: () => SessionParts, snapshot: ToolSnapshot): PiRuntimeTool {
	const prepareArguments = snapshot.prepareArguments
		? (args: unknown): unknown => {
				validate();
				return Reflect.apply(
					snapshot.prepareArguments as (args: unknown) => unknown,
					snapshot.entry,
					[args],
				);
			}
		: undefined;
	return Object.freeze({
		get parameters(): object {
			validate();
			return snapshot.parameters;
		},
		get prepareArguments(): ((args: unknown) => unknown) | undefined {
			validate();
			return prepareArguments;
		},
		get executionMode(): "parallel" | "sequential" | undefined {
			validate();
			return snapshot.executionMode;
		},
		execute(
			toolCallId: string,
			params: unknown,
			signal?: AbortSignal,
			onUpdate?: (partialResult: unknown) => void,
		): Promise<unknown> {
			validate();
			return Reflect.apply(snapshot.execute, snapshot.entry, [
				toolCallId,
				params,
				signal,
				onUpdate,
			]);
		},
	});
}

function createToolRegistryFacade(
	validate: () => SessionParts,
	toolSnapshots: readonly ToolSnapshot[],
): ReadonlyMap<string, PiRuntimeTool> {
	const toolsByName = new Map(
		toolSnapshots.map((snapshot) => [snapshot.name, createToolFacade(validate, snapshot)]),
	);
	let facade: ReadonlyMap<string, PiRuntimeTool>;
	const implementation = {
		get size(): number {
			validate();
			return toolSnapshots.length;
		},
		get(name: string): PiRuntimeTool | undefined {
			validate();
			return toolsByName.get(name);
		},
		has(name: string): boolean {
			validate();
			return toolsByName.has(name);
		},
		forEach(
			callback: (
				value: PiRuntimeTool,
				key: string,
				map: ReadonlyMap<string, PiRuntimeTool>,
			) => void,
			thisArg?: unknown,
		): void {
			validate();
			for (const snapshot of toolSnapshots) {
				validate();
				Reflect.apply(callback, thisArg, [toolsByName.get(snapshot.name), snapshot.name, facade]);
			}
		},
		entries(): IterableIterator<[string, PiRuntimeTool]> {
			validate();
			return createGuardedIterator(validate, toolSnapshots.length, (index) => {
				const snapshot = toolSnapshots[index];
				if (!snapshot) throw new PiRuntimeCompatibilityError(PI_RUNTIME_DIAGNOSTICS.STALE_CAPTURE);
				return [snapshot.name, toolsByName.get(snapshot.name) as PiRuntimeTool];
			});
		},
		keys(): IterableIterator<string> {
			validate();
			return createGuardedIterator(validate, toolSnapshots.length, (index) => {
				const snapshot = toolSnapshots[index];
				if (!snapshot) throw new PiRuntimeCompatibilityError(PI_RUNTIME_DIAGNOSTICS.STALE_CAPTURE);
				return snapshot.name;
			});
		},
		values(): IterableIterator<PiRuntimeTool> {
			validate();
			return createGuardedIterator(validate, toolSnapshots.length, (index) => {
				const snapshot = toolSnapshots[index];
				if (!snapshot) throw new PiRuntimeCompatibilityError(PI_RUNTIME_DIAGNOSTICS.STALE_CAPTURE);
				return toolsByName.get(snapshot.name) as PiRuntimeTool;
			});
		},
		[Symbol.iterator](): IterableIterator<[string, PiRuntimeTool]> {
			validate();
			return implementation.entries();
		},
	};
	facade = Object.freeze(implementation) as unknown as ReadonlyMap<string, PiRuntimeTool>;
	return facade;
}

function installCapturedRuntimeActions(
	state: PatchState,
	slotBySession: WeakMap<object, LifecycleSlot>,
	session: object,
	association: SessionAssociation,
	replacements: PiSharedRuntime,
): PiRuntimeActionsInstallation {
	const initialParts = requireCurrentSessionParts(state, slotBySession, session, association);
	if (!validateRuntimeActionReplacements(replacements)) {
		throw new TypeError(PI_RUNTIME_DIAGNOSTICS.INVALID_RUNTIME_ACTION_REPLACEMENTS);
	}
	if (association.runtimeActionsInstalled) {
		throw new PiRuntimeCompatibilityError(PI_RUNTIME_DIAGNOSTICS.RUNTIME_ACTIONS_ALREADY_INSTALLED);
	}
	const originalDescriptors = getRuntimeActionDescriptors(initialParts.sharedRuntime, initialParts);
	if (!originalDescriptors) {
		throw new PiRuntimeCompatibilityError(PI_RUNTIME_DIAGNOSTICS.UNPATCHABLE_RUNTIME_ACTIONS);
	}
	const originalGetActiveTools = initialParts.getActiveTools;
	const originalSetActiveTools = initialParts.setActiveTools;
	const originalRefreshTools = initialParts.refreshTools;
	let restored = false;
	let installed = false;
	let ownedActions: PiSharedRuntime;
	const requireInstalledParts = (): SessionParts => {
		if (restored || !installed || !association.runtimeActionsInstalled) {
			throw new PiRuntimeCompatibilityError(PI_RUNTIME_DIAGNOSTICS.STALE_CAPTURE);
		}
		const parts = requireCurrentSessionParts(state, slotBySession, session, association);
		if (
			parts.getActiveTools !== ownedActions.getActiveTools ||
			parts.setActiveTools !== ownedActions.setActiveTools ||
			parts.refreshTools !== ownedActions.refreshTools
		) {
			throwStaleCapture(state, slotBySession, session, association);
		}
		return parts;
	};
	ownedActions = Object.freeze({
		getActiveTools(): string[] {
			requireInstalledParts();
			return Reflect.apply(replacements.getActiveTools, replacements, []);
		},
		setActiveTools(toolNames: string[]): void {
			requireInstalledParts();
			Reflect.apply(replacements.setActiveTools, replacements, [toolNames]);
		},
		refreshTools(): void {
			requireInstalledParts();
			Reflect.apply(replacements.refreshTools, replacements, []);
		},
	});
	const restoreOwnedDescriptors = (): Error | undefined => {
		let firstError: Error | undefined;
		for (const property of RUNTIME_ACTION_PROPERTIES) {
			try {
				if (
					Object.getOwnPropertyDescriptor(initialParts.sharedRuntime, property)?.value ===
					ownedActions[property]
				) {
					Object.defineProperty(
						initialParts.sharedRuntime,
						property,
						originalDescriptors[property],
					);
				}
			} catch (error) {
				firstError ??= error instanceof Error ? error : new Error(String(error));
			}
		}
		return firstError;
	};
	try {
		Object.defineProperties(initialParts.sharedRuntime, {
			[GET_ACTIVE_TOOLS_PROPERTY]: {
				...originalDescriptors.getActiveTools,
				value: ownedActions.getActiveTools,
			},
			[SET_ACTIVE_TOOLS_PROPERTY]: {
				...originalDescriptors.setActiveTools,
				value: ownedActions.setActiveTools,
			},
			[REFRESH_TOOLS_PROPERTY]: {
				...originalDescriptors.refreshTools,
				value: ownedActions.refreshTools,
			},
		});
	} catch (error) {
		restoreOwnedDescriptors();
		throw new PiRuntimeCompatibilityError(
			diagnostic(PI_RUNTIME_DIAGNOSTICS.RUNTIME_ACTION_PATCH_FAILED, String(error)),
		);
	}
	let validation: ReturnType<typeof validateSession>;
	try {
		validation = validateSession(session);
	} catch (error) {
		restoreOwnedDescriptors();
		throw new PiRuntimeCompatibilityError(
			diagnostic(PI_RUNTIME_DIAGNOSTICS.RUNTIME_ACTION_PATCH_FAILED, String(error)),
		);
	}
	if (
		!validation.compatible ||
		!sessionPartsMatchWithRuntimeActions(validation.parts, initialParts, ownedActions)
	) {
		restoreOwnedDescriptors();
		throw new PiRuntimeCompatibilityError(
			validation.compatible
				? PI_RUNTIME_DIAGNOSTICS.RUNTIME_ACTION_PATCH_FAILED
				: validation.diagnostic,
		);
	}
	association.parts = validation.parts;
	association.runtimeActionsInstalled = true;
	installed = true;

	const original: PiRuntimeOriginalActions = Object.freeze({
		getActiveTools(): string[] {
			const parts = requireInstalledParts();
			return Reflect.apply(originalGetActiveTools, parts.sharedRuntime, []);
		},
		setActiveTools(toolNames: string[]): void {
			const parts = requireInstalledParts();
			Reflect.apply(originalSetActiveTools, parts.sharedRuntime, [toolNames]);
		},
		refreshTools(): void {
			const beforeRefresh = requireInstalledParts();
			Reflect.apply(originalRefreshTools, beforeRefresh.sharedRuntime, []);
			let refreshed: ReturnType<typeof validateSession>;
			try {
				refreshed = validateSession(session);
			} catch {
				throwStaleCapture(state, slotBySession, session, association);
			}
			if (
				!refreshed.compatible ||
				!sessionPartsMatchAfterToolRefresh(refreshed.parts, beforeRefresh, ownedActions)
			) {
				throwStaleCapture(state, slotBySession, session, association);
			}
			let definition: unknown;
			try {
				definition = Reflect.apply(refreshed.parts.getToolDefinition, session, [PTC_TOOL_NAME]);
			} catch {
				throwStaleCapture(state, slotBySession, session, association);
			}
			if (
				definition !== association.definition ||
				getTaggedInstaller(definition) !== association.installer
			) {
				throwStaleCapture(state, slotBySession, session, association);
			}
			association.parts = refreshed.parts;
			association.toolGeneration += 1;
		},
		snapshotTools(): readonly PiRuntimeToolEntry[] {
			const parts = requireInstalledParts();
			const toolGeneration = association.toolGeneration;
			const validateTool = (): SessionParts => {
				const current = requireInstalledParts();
				if (association.toolGeneration !== toolGeneration) {
					throw new PiRuntimeCompatibilityError(PI_RUNTIME_DIAGNOSTICS.STALE_CAPTURE);
				}
				return current;
			};
			const entries = parts.toolSnapshots.map((snapshot) => {
				let definition: unknown;
				try {
					definition = Reflect.apply(parts.getToolDefinition, session, [snapshot.name]);
				} catch {
					throwStaleCapture(state, slotBySession, session, association);
				}
				return Object.freeze({
					name: snapshot.name,
					executable: createToolFacade(validateTool, snapshot),
					definition,
				});
			});
			return Object.freeze(entries);
		},
	});
	return Object.freeze({
		original,
		restore(activeToolNames?: readonly string[]): void {
			if (restored) return;
			let restoreError: Error | undefined;
			try {
				if (activeToolNames) {
					Reflect.apply(originalSetActiveTools, initialParts.sharedRuntime, [[...activeToolNames]]);
				}
			} catch (error) {
				restoreError = error instanceof Error ? error : new Error(String(error));
			} finally {
				restored = true;
				installed = false;
				association.runtimeActionsInstalled = false;
				restoreError ??= restoreOwnedDescriptors();
				clearCurrentSlot(slotBySession, session, association);
			}
			if (restoreError) throw restoreError;
		},
	});
}

function installCapturedRuntimeEventFinalizers(
	state: PatchState,
	slotBySession: WeakMap<object, LifecycleSlot>,
	session: object,
	association: SessionAssociation,
	finalizers: PiRuntimeEventFinalizers,
): PiRuntimeEventFinalizersInstallation {
	const initialParts = requireCurrentSessionParts(state, slotBySession, session, association);
	if (!validateRuntimeEventFinalizers(finalizers)) {
		throw new TypeError(PI_RUNTIME_DIAGNOSTICS.INVALID_RUNTIME_EVENT_FINALIZERS);
	}
	if (association.runtimeEventFinalizersInstalled) {
		throw new PiRuntimeCompatibilityError(
			PI_RUNTIME_DIAGNOSTICS.RUNTIME_EVENT_FINALIZERS_ALREADY_INSTALLED,
		);
	}
	const originalShapes = initialParts.eventMethods;
	let restored = false;
	let installed = false;
	const wrappers = {} as Record<RunnerEventProperty, RunnerEventMethod>;
	const requireInstalledParts = (): SessionParts => {
		if (restored || !installed || !association.runtimeEventFinalizersInstalled) {
			throw new PiRuntimeCompatibilityError(PI_RUNTIME_DIAGNOSTICS.STALE_CAPTURE);
		}
		const parts = requireCurrentSessionParts(state, slotBySession, session, association);
		try {
			if (!inheritedRunnerEventSourcesMatch(originalShapes)) {
				throwStaleCapture(state, slotBySession, session, association);
			}
		} catch {
			throwStaleCapture(state, slotBySession, session, association);
		}
		return parts;
	};
	for (const property of RUNTIME_EVENT_PROPERTIES) {
		const originalMethod = originalShapes[property].method;
		const finalizer =
			property === EMIT_TOOL_CALL_PROPERTY
				? finalizers.finalizeToolCall
				: finalizers.finalizeBeforeAgentStart;
		wrappers[property] = async function (this: object, ...args: unknown[]): Promise<unknown> {
			const beforeAggregation = requireInstalledParts();
			const result = await Reflect.apply(originalMethod, beforeAggregation.extensionRunner, args);
			const afterAggregation = requireInstalledParts();
			const context = Reflect.apply(
				afterAggregation.createContext,
				afterAggregation.extensionRunner,
				[],
			);
			return Reflect.apply(finalizer, finalizers, [args, result, context]);
		};
	}
	const restoreOwnedWrappers = (): Error | undefined => {
		let firstError: Error | undefined;
		for (const property of RUNTIME_EVENT_PROPERTIES) {
			try {
				if (
					Object.getOwnPropertyDescriptor(initialParts.extensionRunner, property)?.value !==
					wrappers[property]
				) {
					continue;
				}
				const originalShape = originalShapes[property];
				if (originalShape.own) {
					Object.defineProperty(initialParts.extensionRunner, property, originalShape.descriptor);
				} else if (!Reflect.deleteProperty(initialParts.extensionRunner, property)) {
					throw new Error(`${RESTORE_INHERITED_EVENT_METHOD_ERROR_PREFIX} ${property}`);
				}
			} catch (error) {
				firstError ??= error instanceof Error ? error : new Error(String(error));
			}
		}
		return firstError;
	};
	try {
		for (const property of RUNTIME_EVENT_PROPERTIES) {
			const originalShape = originalShapes[property];
			// Inherited Pi methods need a removable own shadow so restore reveals inheritance again.
			const descriptor = originalShape.own
				? { ...originalShape.descriptor, value: wrappers[property] }
				: {
						value: wrappers[property],
						configurable: true,
						enumerable: originalShape.descriptor.enumerable,
						writable: true,
					};
			Object.defineProperty(initialParts.extensionRunner, property, descriptor);
		}
	} catch (error) {
		restoreOwnedWrappers();
		throw new PiRuntimeCompatibilityError(
			diagnostic(PI_RUNTIME_DIAGNOSTICS.RUNTIME_EVENT_FINALIZER_PATCH_FAILED, String(error)),
		);
	}
	let validation: ReturnType<typeof validateSession>;
	try {
		validation = validateSession(session);
	} catch (error) {
		restoreOwnedWrappers();
		throw new PiRuntimeCompatibilityError(
			diagnostic(PI_RUNTIME_DIAGNOSTICS.RUNTIME_EVENT_FINALIZER_PATCH_FAILED, String(error)),
		);
	}
	let inheritedSourcesCurrent = false;
	try {
		inheritedSourcesCurrent = inheritedRunnerEventSourcesMatch(originalShapes);
	} catch {}
	if (
		!validation.compatible ||
		!inheritedSourcesCurrent ||
		!sessionPartsMatchWithRuntimeEventFinalizers(validation.parts, initialParts, wrappers)
	) {
		restoreOwnedWrappers();
		throw new PiRuntimeCompatibilityError(
			validation.compatible
				? PI_RUNTIME_DIAGNOSTICS.RUNTIME_EVENT_FINALIZER_PATCH_FAILED
				: validation.diagnostic,
		);
	}
	association.parts = validation.parts;
	association.runtimeEventFinalizersInstalled = true;
	installed = true;

	return Object.freeze({
		restore(): void {
			if (restored) return;
			restored = true;
			installed = false;
			association.runtimeEventFinalizersInstalled = false;
			const restoreError = restoreOwnedWrappers();
			clearCurrentSlot(slotBySession, session, association);
			if (restoreError) throw restoreError;
		},
	});
}

function createCapturedSession(
	state: PatchState,
	slotBySession: WeakMap<object, LifecycleSlot>,
	session: object,
	association: SessionAssociation,
): CapturedPiSession {
	const validate = (): SessionParts =>
		requireCurrentSessionParts(state, slotBySession, session, association);
	const initialToolGeneration = association.toolGeneration;
	const validateInitialTools = (): SessionParts => {
		const parts = validate();
		if (association.toolGeneration !== initialToolGeneration) {
			throw new PiRuntimeCompatibilityError(PI_RUNTIME_DIAGNOSTICS.STALE_CAPTURE);
		}
		return parts;
	};
	const extensionRunner = Object.freeze({
		createContext(): unknown {
			const parts = validate();
			return Reflect.apply(parts.createContext, parts.extensionRunner, []);
		},
		emit(event: unknown): Promise<unknown> {
			const parts = validate();
			return Reflect.apply(parts.emit, parts.extensionRunner, [event]);
		},
	});
	const sharedRuntime = Object.freeze({
		getActiveTools(): string[] {
			const parts = validate();
			return Reflect.apply(parts.getActiveTools, parts.sharedRuntime, []);
		},
		setActiveTools(toolNames: string[]): void {
			const parts = validate();
			Reflect.apply(parts.setActiveTools, parts.sharedRuntime, [toolNames]);
		},
		refreshTools(): void {
			const parts = validate();
			Reflect.apply(parts.refreshTools, parts.sharedRuntime, []);
		},
	});
	const toolRegistry = createToolRegistryFacade(
		validateInitialTools,
		association.parts.toolSnapshots,
	);
	const beforeToolCall = (...args: unknown[]): Promise<unknown> => {
		const parts = validate();
		return Reflect.apply(parts.beforeToolCall, parts.agent, args);
	};
	const afterToolCall = (...args: unknown[]): Promise<unknown> => {
		const parts = validate();
		return Reflect.apply(parts.afterToolCall, parts.agent, args);
	};
	return Object.freeze({
		get version(): typeof SUPPORTED_PI_VERSION {
			validate();
			return SUPPORTED_PI_VERSION;
		},
		get extensionRunner(): PiExtensionRunner {
			validate();
			return extensionRunner;
		},
		get sharedRuntime(): PiSharedRuntime {
			validate();
			return sharedRuntime;
		},
		get toolRegistry(): ReadonlyMap<string, PiRuntimeTool> {
			validate();
			return toolRegistry;
		},
		get beforeToolCall(): (...args: unknown[]) => Promise<unknown> {
			validate();
			return beforeToolCall;
		},
		get afterToolCall(): (...args: unknown[]) => Promise<unknown> {
			validate();
			return afterToolCall;
		},
		getToolDefinition(name: string): unknown {
			const parts = validate();
			return Reflect.apply(parts.getToolDefinition, session, [name]);
		},
		installRuntimeActions(replacements: PiSharedRuntime): PiRuntimeActionsInstallation {
			validate();
			return installCapturedRuntimeActions(
				state,
				slotBySession,
				session,
				association,
				replacements,
			);
		},
		installRuntimeEventFinalizers(
			finalizers: PiRuntimeEventFinalizers,
		): PiRuntimeEventFinalizersInstallation {
			validate();
			return installCapturedRuntimeEventFinalizers(
				state,
				slotBySession,
				session,
				association,
				finalizers,
			);
		},
	});
}

function inspectBoundSession(
	state: PatchState,
	slotBySession: WeakMap<object, LifecycleSlot>,
	session: object,
	invocation: LifecycleInvocation,
): void {
	if (!state.active || slotBySession.get(session) !== invocation) {
		return;
	}
	if (!isRecord(session) || typeof session[GET_TOOL_DEFINITION_PROPERTY] !== "function") {
		clearCurrentSlot(slotBySession, session, invocation);
		throw new PiRuntimeCompatibilityError(PI_RUNTIME_DIAGNOSTICS.MISSING_TOOL_LOOKUP);
	}
	const definition = Reflect.apply(session[GET_TOOL_DEFINITION_PROPERTY], session, [PTC_TOOL_NAME]);
	const installer = getTaggedInstaller(definition);
	if (!installer) {
		clearCurrentSlot(slotBySession, session, invocation);
		return;
	}
	const validation = validateSession(session);
	if (!validation.compatible) {
		try {
			installer.capturePiRuntime(incompatible(validation.diagnostic));
		} catch (error) {
			clearCurrentSlot(slotBySession, session, invocation);
			throw error;
		}
		clearCurrentSlot(slotBySession, session, invocation);
		return;
	}
	if (!state.active || slotBySession.get(session) !== invocation) {
		return;
	}
	const association: SessionAssociation = {
		kind: ASSOCIATION_SLOT_KIND,
		installer,
		definition: definition as object,
		parts: validation.parts,
		toolGeneration: 0,
		runtimeActionsInstalled: false,
		runtimeEventFinalizersInstalled: false,
	};
	slotBySession.set(session, association);
	try {
		installer.capturePiRuntime({
			compatible: true,
			session: createCapturedSession(state, slotBySession, session, association),
		});
	} catch (error) {
		clearCurrentSlot(slotBySession, session, association);
		throw error;
	}
}

function createPatchedLifecycleMethod(
	state: PatchState,
	slotBySession: WeakMap<object, LifecycleSlot>,
	originalFunction: LifecycleMethod,
	invocationKind: typeof BIND_INVOCATION_SLOT_KIND | typeof RELOAD_INVOCATION_SLOT_KIND,
): LifecycleMethod {
	return async function (this: object, ...args: unknown[]): Promise<unknown> {
		const currentSlot = slotBySession.get(this);
		const retainedAssociation =
			currentSlot?.kind === ASSOCIATION_SLOT_KIND
				? currentSlot
				: currentSlot?.kind === RELOAD_INVOCATION_SLOT_KIND
					? currentSlot.retainedAssociation
					: undefined;
		const invocation: LifecycleInvocation =
			invocationKind === BIND_INVOCATION_SLOT_KIND
				? { kind: BIND_INVOCATION_SLOT_KIND }
				: { kind: RELOAD_INVOCATION_SLOT_KIND, retainedAssociation };
		slotBySession.set(this, invocation);
		let result: unknown;
		try {
			result = await Reflect.apply(originalFunction, this, args);
		} catch (error) {
			if (invocationOwnsSlotAtSettlement(slotBySession, this, invocation)) {
				clearCurrentSlot(slotBySession, this, invocation);
			}
			throw error;
		}
		if (!invocationOwnsSlotAtSettlement(slotBySession, this, invocation)) {
			return result;
		}
		if (!state.active) {
			clearCurrentSlot(slotBySession, this, invocation);
			return result;
		}
		inspectBoundSession(state, slotBySession, this, invocation);
		return result;
	};
}

function validateLifecycleDescriptor(
	prototype: object,
	property: string,
	missingDiagnostic: string,
	unpatchableDiagnostic: string,
): LifecycleDescriptorValidation {
	const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
	if (!descriptor || typeof descriptor.value !== "function") {
		return { compatible: false, diagnostic: missingDiagnostic };
	}
	if (descriptor.configurable !== true && descriptor.writable !== true) {
		return { compatible: false, diagnostic: unpatchableDiagnostic };
	}
	return {
		compatible: true,
		descriptor,
		method: descriptor.value as LifecycleMethod,
	};
}

function lifecyclePatchIsCurrent(prototype: object, patch: LifecyclePatch): boolean {
	return (
		Object.getOwnPropertyDescriptor(prototype, patch.property)?.value === patch.patchedFunction
	);
}

function restoreOwnedLifecyclePatch(prototype: object, patch: LifecyclePatch): void {
	if (lifecyclePatchIsCurrent(prototype, patch)) {
		Object.defineProperty(prototype, patch.property, patch.originalDescriptor);
	}
}

function incrementInstallationCount(installed: ValidatedPatchState): boolean {
	const nextInstallations = installed.installations + 1;
	if (!Number.isSafeInteger(nextInstallations)) return false;
	const currentDescriptor = getOwnDataPropertyDescriptor(installed.state, INSTALLATIONS_PROPERTY);
	if (
		currentDescriptor?.value !== installed.installations ||
		currentDescriptor.writable !== true ||
		!Reflect.set(installed.state, INSTALLATIONS_PROPERTY, nextInstallations)
	) {
		return false;
	}
	return (
		getOwnDataPropertyDescriptor(installed.state, INSTALLATIONS_PROPERTY)?.value ===
		nextInstallations
	);
}

function teardownPatch(
	prototype: object,
	state: PatchState,
	bindExtensions: LifecyclePatch,
	reload: LifecyclePatch,
	registry: WeakMap<object, PatchState>,
): void {
	if (state.installations === 0) return;
	state.installations -= 1;
	if (state.installations !== 0) return;
	state.active = false;
	restoreOwnedLifecyclePatch(prototype, bindExtensions);
	restoreOwnedLifecyclePatch(prototype, reload);
	Reflect.apply(WEAK_MAP_DELETE_METHOD, registry, [prototype]);
}

export function tagPtcToolDefinition<TDefinition extends object>(
	definition: TDefinition,
	installer: PiRuntimeInstaller,
): TDefinition {
	if (typeof installer.capturePiRuntime !== "function") {
		throw new TypeError(PI_RUNTIME_DIAGNOSTICS.INVALID_INSTALLER);
	}
	Object.defineProperty(definition, TOOL_INSTALLER_TAG, {
		value: installer,
		configurable: true,
	});
	return definition;
}

export function installPiRuntimeCapturePatch(
	options: PiRuntimePatchOptions = {},
): PiRuntimePatchInstallation {
	const versionDiagnostic = getPiRuntimeVersionDiagnostic(VERSION, options.version);
	if (versionDiagnostic) {
		return { compatible: false, diagnostic: versionDiagnostic };
	}
	const agentSession = options.agentSession ?? AgentSession;
	const prototype = agentSession.prototype;
	const globalObject = options.globalObject ?? globalThis;
	let registry: WeakMap<object, PatchState>;
	let coordinatorRegistry: WeakMap<object, LifecycleCoordinator>;
	let installed: ValidatedPatchState | undefined;
	let coordinator: LifecycleCoordinator;
	let slotBySession: WeakMap<object, LifecycleSlot>;
	try {
		registry = getPatchRegistry(globalObject);
		coordinatorRegistry = getLifecycleCoordinatorRegistry(globalObject);
		const installedEntry = getWeakMapEntry(registry, prototype);
		const coordinatorEntry = getWeakMapEntry(coordinatorRegistry, prototype);
		if (coordinatorEntry.present) {
			const coordinatorValidation = validateLifecycleCoordinator(coordinatorEntry.value);
			if (!coordinatorValidation) {
				throw incompatibleGlobalRegistry(LIFECYCLE_COORDINATOR_REGISTRY_SYMBOL_NAME);
			}
			coordinator = coordinatorValidation.coordinator;
			slotBySession = coordinatorValidation.slotBySession;
		} else {
			if (installedEntry.present) {
				throw incompatibleGlobalRegistry(PATCH_REGISTRY_SYMBOL_NAME);
			}
			slotBySession = new WeakMap<object, LifecycleSlot>();
			coordinator = { slotBySession };
			setWeakMapEntry(coordinatorRegistry, prototype, coordinator);
		}
		if (installedEntry.present) {
			installed = validatePatchState(installedEntry.value, coordinator);
			if (!installed) {
				throw incompatibleGlobalRegistry(PATCH_REGISTRY_SYMBOL_NAME);
			}
		}
	} catch (error) {
		return {
			compatible: false,
			diagnostic:
				error instanceof PiRuntimeCompatibilityError
					? error.message
					: diagnostic(PI_RUNTIME_DIAGNOSTICS.GLOBAL_REGISTRY, String(error)),
		};
	}
	if (installed) {
		try {
			if (
				!lifecyclePatchIsCurrent(prototype, installed.bindExtensions) ||
				!lifecyclePatchIsCurrent(prototype, installed.reload)
			) {
				return { compatible: false, diagnostic: PI_RUNTIME_DIAGNOSTICS.PATCH_CONFLICT };
			}
			if (!incrementInstallationCount(installed)) {
				throw incompatibleGlobalRegistry(PATCH_REGISTRY_SYMBOL_NAME);
			}
		} catch (error) {
			return {
				compatible: false,
				diagnostic:
					error instanceof PiRuntimeCompatibilityError
						? error.message
						: diagnostic(PI_RUNTIME_DIAGNOSTICS.GLOBAL_REGISTRY, String(error)),
			};
		}
		let tornDown = false;
		return {
			compatible: true,
			teardown: () => {
				if (tornDown) return;
				tornDown = true;
				teardownPatch(
					prototype,
					installed.state,
					installed.bindExtensions,
					installed.reload,
					registry,
				);
			},
		};
	}
	const bindValidation = validateLifecycleDescriptor(
		prototype,
		BIND_EXTENSIONS_PROPERTY,
		PI_RUNTIME_DIAGNOSTICS.MISSING_BIND_EXTENSIONS,
		PI_RUNTIME_DIAGNOSTICS.UNPATCHABLE_BIND_EXTENSIONS,
	);
	if (!bindValidation.compatible) {
		return bindValidation;
	}
	const reloadValidation = validateLifecycleDescriptor(
		prototype,
		RELOAD_PROPERTY,
		PI_RUNTIME_DIAGNOSTICS.MISSING_RELOAD,
		PI_RUNTIME_DIAGNOSTICS.UNPATCHABLE_RELOAD,
	);
	if (!reloadValidation.compatible) {
		return reloadValidation;
	}
	const state: PatchState = {
		active: true,
		installations: 1,
		bindExtensions: {
			property: BIND_EXTENSIONS_PROPERTY,
			originalDescriptor: bindValidation.descriptor,
			originalFunction: bindValidation.method,
			patchedFunction: undefined as unknown as LifecycleMethod,
		},
		reload: {
			property: RELOAD_PROPERTY,
			originalDescriptor: reloadValidation.descriptor,
			originalFunction: reloadValidation.method,
			patchedFunction: undefined as unknown as LifecycleMethod,
		},
		coordinator,
	};
	state.bindExtensions.patchedFunction = createPatchedLifecycleMethod(
		state,
		slotBySession,
		state.bindExtensions.originalFunction,
		BIND_INVOCATION_SLOT_KIND,
	);
	state.reload.patchedFunction = createPatchedLifecycleMethod(
		state,
		slotBySession,
		state.reload.originalFunction,
		RELOAD_INVOCATION_SLOT_KIND,
	);
	try {
		Object.defineProperty(prototype, BIND_EXTENSIONS_PROPERTY, {
			...bindValidation.descriptor,
			value: state.bindExtensions.patchedFunction,
		});
		Object.defineProperty(prototype, RELOAD_PROPERTY, {
			...reloadValidation.descriptor,
			value: state.reload.patchedFunction,
		});
	} catch (error) {
		state.active = false;
		restoreOwnedLifecyclePatch(prototype, state.bindExtensions);
		restoreOwnedLifecyclePatch(prototype, state.reload);
		return {
			compatible: false,
			diagnostic: diagnostic(PI_RUNTIME_DIAGNOSTICS.PATCH_FAILED, String(error)),
		};
	}
	try {
		setWeakMapEntry(registry, prototype, state);
	} catch (error) {
		state.active = false;
		restoreOwnedLifecyclePatch(prototype, state.bindExtensions);
		restoreOwnedLifecyclePatch(prototype, state.reload);
		return {
			compatible: false,
			diagnostic: diagnostic(PI_RUNTIME_DIAGNOSTICS.GLOBAL_REGISTRY, String(error)),
		};
	}
	let tornDown = false;
	return {
		compatible: true,
		teardown: () => {
			if (tornDown) return;
			tornDown = true;
			teardownPatch(prototype, state, state.bindExtensions, state.reload, registry);
		},
	};
}

export function ensureSharedPiRuntimeCapturePatch(
	options: PiRuntimePatchOptions = {},
): PiRuntimeSharedPatchEnsure {
	const versionDiagnostic = getPiRuntimeVersionDiagnostic(VERSION, options.version);
	if (versionDiagnostic) {
		return { compatible: false, diagnostic: versionDiagnostic };
	}
	const agentSession = options.agentSession ?? AgentSession;
	const prototype = agentSession.prototype;
	const globalObject = options.globalObject ?? globalThis;
	let sharedRegistry: WeakMap<object, SharedPatchLease>;
	try {
		sharedRegistry = getSharedPatchLeaseRegistry(globalObject);
		const sharedEntry = getWeakMapEntry(sharedRegistry, prototype);
		if (sharedEntry.present) {
			const patchRegistry = getPatchRegistry(globalObject);
			const coordinatorRegistry = getLifecycleCoordinatorRegistry(globalObject);
			const patchEntry = getWeakMapEntry(patchRegistry, prototype);
			const coordinatorEntry = getWeakMapEntry(coordinatorRegistry, prototype);
			if (!patchEntry.present || !coordinatorEntry.present) {
				throw incompatibleGlobalRegistry(SHARED_PATCH_LEASE_REGISTRY_SYMBOL_NAME);
			}
			const coordinatorValidation = validateLifecycleCoordinator(coordinatorEntry.value);
			if (!coordinatorValidation) {
				throw incompatibleGlobalRegistry(LIFECYCLE_COORDINATOR_REGISTRY_SYMBOL_NAME);
			}
			const patchValidation = validatePatchState(
				patchEntry.value,
				coordinatorValidation.coordinator,
			);
			if (
				!patchValidation ||
				!validateSharedPatchLease(
					sharedEntry.value,
					patchValidation.state,
					coordinatorValidation.coordinator,
				)
			) {
				throw incompatibleGlobalRegistry(SHARED_PATCH_LEASE_REGISTRY_SYMBOL_NAME);
			}
			if (
				!lifecyclePatchIsCurrent(prototype, patchValidation.bindExtensions) ||
				!lifecyclePatchIsCurrent(prototype, patchValidation.reload)
			) {
				return { compatible: false, diagnostic: PI_RUNTIME_DIAGNOSTICS.PATCH_CONFLICT };
			}
			return { compatible: true };
		}
	} catch (error) {
		return {
			compatible: false,
			diagnostic:
				error instanceof PiRuntimeCompatibilityError
					? error.message
					: diagnostic(PI_RUNTIME_DIAGNOSTICS.GLOBAL_REGISTRY, String(error)),
		};
	}

	const installation = installPiRuntimeCapturePatch(options);
	if (!installation.compatible) return installation;
	let lease: SharedPatchLease | undefined;
	try {
		const patchRegistry = getPatchRegistry(globalObject);
		const coordinatorRegistry = getLifecycleCoordinatorRegistry(globalObject);
		const patchEntry = getWeakMapEntry(patchRegistry, prototype);
		const coordinatorEntry = getWeakMapEntry(coordinatorRegistry, prototype);
		if (!patchEntry.present || !coordinatorEntry.present) {
			throw incompatibleGlobalRegistry(SHARED_PATCH_LEASE_REGISTRY_SYMBOL_NAME);
		}
		const coordinatorValidation = validateLifecycleCoordinator(coordinatorEntry.value);
		if (!coordinatorValidation) {
			throw incompatibleGlobalRegistry(LIFECYCLE_COORDINATOR_REGISTRY_SYMBOL_NAME);
		}
		const patchValidation = validatePatchState(patchEntry.value, coordinatorValidation.coordinator);
		if (
			!patchValidation ||
			!lifecyclePatchIsCurrent(prototype, patchValidation.bindExtensions) ||
			!lifecyclePatchIsCurrent(prototype, patchValidation.reload)
		) {
			throw incompatibleGlobalRegistry(PATCH_REGISTRY_SYMBOL_NAME);
		}
		lease = Object.freeze({
			installation,
			state: patchValidation.state,
			coordinator: coordinatorValidation.coordinator,
		});
		setWeakMapEntry(sharedRegistry, prototype, lease);
		const published = getWeakMapEntry(sharedRegistry, prototype);
		if (
			!published.present ||
			published.value !== lease ||
			!validateSharedPatchLease(
				published.value,
				patchValidation.state,
				coordinatorValidation.coordinator,
			)
		) {
			throw incompatibleGlobalRegistry(SHARED_PATCH_LEASE_REGISTRY_SYMBOL_NAME);
		}
		return { compatible: true };
	} catch (error) {
		try {
			const published = getWeakMapEntry(sharedRegistry, prototype);
			if (lease !== undefined && published.present && published.value === lease) {
				Reflect.apply(WEAK_MAP_DELETE_METHOD, sharedRegistry, [prototype]);
			}
		} finally {
			installation.teardown();
		}
		return {
			compatible: false,
			diagnostic:
				error instanceof PiRuntimeCompatibilityError
					? error.message
					: diagnostic(PI_RUNTIME_DIAGNOSTICS.GLOBAL_REGISTRY, String(error)),
		};
	}
}
