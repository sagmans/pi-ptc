import type { PiRuntimeInstaller, PtcTransportOwnership } from "./pi-runtime-contract.ts";
import { diagnostic, PI_RUNTIME_DIAGNOSTICS } from "./pi-runtime-contract.ts";
import type {
	LifecycleCoordinator,
	LifecycleMethod,
	LifecyclePatch,
	LifecycleSlot,
	PatchState,
	SharedPatchLease,
	ValidatedLifecycleCoordinator,
	ValidatedPatchState,
} from "./pi-runtime-registry.ts";
import {
	ACTIVE_PROPERTY,
	BIND_EXTENSIONS_PATCH_PROPERTY,
	BIND_EXTENSIONS_PROPERTY,
	COMPATIBLE_PROPERTY,
	COORDINATOR_PROPERTY,
	DESCRIPTOR_CONFIGURABLE_PROPERTY,
	DESCRIPTOR_ENUMERABLE_PROPERTY,
	DESCRIPTOR_GET_PROPERTY,
	DESCRIPTOR_SET_PROPERTY,
	DESCRIPTOR_VALUE_PROPERTY,
	DESCRIPTOR_WRITABLE_PROPERTY,
	GET_TOOL_DEFINITION_PROPERTY,
	getOwnDataPropertyDescriptor,
	INSTALLATION_PROPERTY,
	INSTALLATIONS_PROPERTY,
	isRecord,
	isRegistryRecord,
	isUsableWeakMap,
	ORIGINAL_DESCRIPTOR_PROPERTY,
	ORIGINAL_FUNCTION_PROPERTY,
	PATCH_PROPERTY_PROPERTY,
	PATCHED_FUNCTION_PROPERTY,
	PiRuntimeCompatibilityError,
	PTC_TOOL_NAME,
	RELOAD_PATCH_PROPERTY,
	RELOAD_PROPERTY,
	SLOT_BY_SESSION_PROPERTY,
	STATE_PROPERTY,
	TEARDOWN_PROPERTY,
	TOOL_INSTALLER_TAG,
} from "./pi-runtime-registry.ts";

export function validateLifecycleCoordinator(
	value: unknown,
): ValidatedLifecycleCoordinator | undefined {
	const slotDescriptor = getOwnDataPropertyDescriptor(value, SLOT_BY_SESSION_PROPERTY);
	if (!slotDescriptor || !isUsableWeakMap(slotDescriptor.value)) return undefined;
	return {
		coordinator: value as LifecycleCoordinator,
		slotBySession: slotDescriptor.value as WeakMap<object, LifecycleSlot>,
	};
}

export function validateStoredLifecycleDescriptor(
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

export function validateLifecyclePatch(
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

export function validatePatchState(
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

export function validateSharedPatchLease(
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

export function getTaggedInstaller(definition: unknown): PiRuntimeInstaller | undefined {
	if (!isRecord(definition)) return undefined;
	const installer = definition[TOOL_INSTALLER_TAG];
	if (!isRecord(installer)) return undefined;
	return typeof installer.capturePiRuntime === "function"
		? (installer as PiRuntimeInstaller)
		: undefined;
}

export function createTransportOwnership(
	session: object,
	getToolDefinition: (name: string) => unknown,
	definition: object,
	installer: PiRuntimeInstaller,
): PtcTransportOwnership {
	return Object.freeze({
		isCurrent(): boolean {
			try {
				if (Reflect.get(session, GET_TOOL_DEFINITION_PROPERTY) !== getToolDefinition) return false;
				const current = Reflect.apply(getToolDefinition, session, [PTC_TOOL_NAME]);
				return current === definition && getTaggedInstaller(current) === installer;
			} catch (error) {
				throw new PiRuntimeCompatibilityError(
					diagnostic(PI_RUNTIME_DIAGNOSTICS.TRANSPORT_OWNERSHIP_CHECK_FAILED, String(error)),
				);
			}
		},
	});
}
