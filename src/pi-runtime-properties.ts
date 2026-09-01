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
