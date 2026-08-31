import { AgentSession, VERSION } from "@earendil-works/pi-coding-agent";
import type { PiRuntimePatchOptions, PiRuntimeSharedPatchEnsure } from "./pi-runtime-contract.ts";
import {
	diagnostic,
	getPiRuntimeVersionDiagnostic,
	PI_RUNTIME_DIAGNOSTICS,
} from "./pi-runtime-contract.ts";
import { installPiRuntimeCapturePatch, lifecyclePatchIsCurrent } from "./pi-runtime-patch.ts";
import type { SharedPatchLease } from "./pi-runtime-registry.ts";
import {
	getLifecycleCoordinatorRegistry,
	getPatchRegistry,
	getSharedPatchLeaseRegistry,
	getWeakMapEntry,
	incompatibleGlobalRegistry,
	LIFECYCLE_COORDINATOR_REGISTRY_SYMBOL_NAME,
	PATCH_REGISTRY_SYMBOL_NAME,
	PiRuntimeCompatibilityError,
	SHARED_PATCH_LEASE_REGISTRY_SYMBOL_NAME,
	setWeakMapEntry,
	WEAK_MAP_DELETE_METHOD,
} from "./pi-runtime-registry.ts";
import {
	validateLifecycleCoordinator,
	validatePatchState,
	validateSharedPatchLease,
} from "./pi-runtime-registry-validation.ts";

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
