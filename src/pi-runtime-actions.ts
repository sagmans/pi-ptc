import {
	associationOwnsDefinition,
	associationRuntimeActionsInstalled,
	clearCurrentSlot,
	installAssociationRuntimeActions,
	refreshAssociationTools,
	requireCurrentSessionParts,
	restoreAssociationRuntimeActions,
	throwStaleCapture,
} from "./pi-runtime-association.ts";
import type {
	PiRuntimeActionsInstallation,
	PiRuntimeOriginalActions,
	PiRuntimeToolEntry,
	PiSharedRuntime,
} from "./pi-runtime-contract.ts";
import { diagnostic, PI_RUNTIME_DIAGNOSTICS } from "./pi-runtime-contract.ts";
import type {
	LifecycleSlot,
	PatchState,
	SessionAssociation,
	SessionParts,
} from "./pi-runtime-registry.ts";
import {
	GET_ACTIVE_TOOLS_PROPERTY,
	PiRuntimeCompatibilityError,
	PTC_TOOL_NAME,
	REFRESH_TOOLS_PROPERTY,
	RUNTIME_ACTION_PROPERTIES,
	SET_ACTIVE_TOOLS_PROPERTY,
} from "./pi-runtime-registry.ts";
import {
	getRuntimeActionDescriptors,
	sessionPartsMatchAfterToolRefresh,
	sessionPartsMatchWithRuntimeActions,
	validateRuntimeActionReplacements,
	validateSession,
} from "./pi-runtime-shape.ts";
import { createToolFacade } from "./pi-runtime-tools.ts";

export function installCapturedRuntimeActions(
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
	if (associationRuntimeActionsInstalled(association)) {
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
		if (restored || !installed || !associationRuntimeActionsInstalled(association)) {
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
	installAssociationRuntimeActions(association, validation.parts);
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
			if (!associationOwnsDefinition(association, definition)) {
				throwStaleCapture(state, slotBySession, session, association);
			}
			refreshAssociationTools(association, refreshed.parts);
		},
		snapshotTools(): readonly PiRuntimeToolEntry[] {
			const parts = requireInstalledParts();
			const entries = parts.toolSnapshots.map((snapshot) => {
				let definition: unknown;
				try {
					definition = Reflect.apply(parts.getToolDefinition, session, [snapshot.name]);
				} catch {
					throwStaleCapture(state, slotBySession, session, association);
				}
				return Object.freeze({
					name: snapshot.name,
					executable: createToolFacade(requireInstalledParts, snapshot),
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
				restoreAssociationRuntimeActions(association);
				const descriptorError = restoreOwnedDescriptors();
				restoreError ??= descriptorError;
				clearCurrentSlot(slotBySession, session, association);
			}
			if (restoreError) throw restoreError;
		},
	});
}
