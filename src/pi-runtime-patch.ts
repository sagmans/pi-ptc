import { AgentSession, VERSION } from "@earendil-works/pi-coding-agent";
import {
	beginLifecycleInvocation,
	clearCurrentSlot,
	invocationOwnsSlotAtSettlement,
} from "./pi-runtime-association.ts";
import type {
	PiRuntimeInstaller,
	PiRuntimePatchInstallation,
	PiRuntimePatchOptions,
} from "./pi-runtime-contract.ts";
import {
	diagnostic,
	getPiRuntimeVersionDiagnostic,
	PI_RUNTIME_DIAGNOSTICS,
} from "./pi-runtime-contract.ts";
import type {
	LifecycleCoordinator,
	LifecycleDescriptorValidation,
	LifecycleInvocation,
	LifecycleMethod,
	LifecyclePatch,
	LifecycleSlot,
	PatchState,
	ValidatedPatchState,
} from "./pi-runtime-registry.ts";
import {
	BIND_EXTENSIONS_PROPERTY,
	BIND_INVOCATION_SLOT_KIND,
	getLifecycleCoordinatorRegistry,
	getOwnDataPropertyDescriptor,
	getPatchRegistry,
	getWeakMapEntry,
	INSTALLATIONS_PROPERTY,
	incompatibleGlobalRegistry,
	LIFECYCLE_COORDINATOR_REGISTRY_SYMBOL_NAME,
	PATCH_REGISTRY_SYMBOL_NAME,
	PiRuntimeCompatibilityError,
	RELOAD_INVOCATION_SLOT_KIND,
	RELOAD_PROPERTY,
	setWeakMapEntry,
	TOOL_INSTALLER_TAG,
	WEAK_MAP_DELETE_METHOD,
} from "./pi-runtime-registry.ts";
import {
	validateLifecycleCoordinator,
	validatePatchState,
} from "./pi-runtime-registry-validation.ts";
import { inspectBoundSession } from "./pi-runtime-session.ts";

export function createPatchedLifecycleMethod(
	state: PatchState,
	slotBySession: WeakMap<object, LifecycleSlot>,
	originalFunction: LifecycleMethod,
	invocationKind: typeof BIND_INVOCATION_SLOT_KIND | typeof RELOAD_INVOCATION_SLOT_KIND,
): LifecycleMethod {
	return async function (this: object, ...args: unknown[]): Promise<unknown> {
		const invocation: LifecycleInvocation = beginLifecycleInvocation(
			slotBySession,
			this,
			invocationKind,
		);
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

export function validateLifecycleDescriptor(
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

export function lifecyclePatchIsCurrent(prototype: object, patch: LifecyclePatch): boolean {
	return (
		Object.getOwnPropertyDescriptor(prototype, patch.property)?.value === patch.patchedFunction
	);
}

export function restoreOwnedLifecyclePatch(prototype: object, patch: LifecyclePatch): void {
	if (lifecyclePatchIsCurrent(prototype, patch)) {
		Object.defineProperty(prototype, patch.property, patch.originalDescriptor);
	}
}

export function incrementInstallationCount(installed: ValidatedPatchState): boolean {
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

export function teardownPatch(
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
