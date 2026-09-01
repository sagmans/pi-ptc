import type { PiRuntimeInstaller } from "./pi-runtime-contract.ts";
import { PI_RUNTIME_DIAGNOSTICS } from "./pi-runtime-contract.ts";
import type {
	LifecycleInvocation,
	LifecycleSlot,
	PatchState,
	SessionParts,
} from "./pi-runtime-registry.ts";
import {
	ASSOCIATION_SLOT_KIND,
	BIND_INVOCATION_SLOT_KIND,
	PiRuntimeCompatibilityError,
	PTC_TOOL_NAME,
	RELOAD_INVOCATION_SLOT_KIND,
} from "./pi-runtime-registry.ts";
import { getTaggedInstaller } from "./pi-runtime-registry-validation.ts";
import { sessionPartsMatch, validateSession } from "./pi-runtime-shape.ts";

const INITIAL_TOOL_GENERATION = 0;
const TOOL_GENERATION_INCREMENT = 1;
declare const SESSION_ASSOCIATION_HANDLE: unique symbol;

export type SessionAssociation = {
	readonly [SESSION_ASSOCIATION_HANDLE]: true;
};

type SessionAssociationState = {
	kind: typeof ASSOCIATION_SLOT_KIND;
	installer: PiRuntimeInstaller;
	definition: object;
	parts: SessionParts;
	toolGeneration: number;
	runtimeActionsInstalled: boolean;
	runtimeEventFinalizersInstalled: boolean;
};

function associationState(association: SessionAssociation): SessionAssociationState {
	return association as unknown as SessionAssociationState;
}

export function associationToolGeneration(association: SessionAssociation): number {
	return associationState(association).toolGeneration;
}

export function associationToolSnapshots(
	association: SessionAssociation,
): SessionParts["toolSnapshots"] {
	return associationState(association).parts.toolSnapshots;
}

export function associationRuntimeActionsInstalled(association: SessionAssociation): boolean {
	return associationState(association).runtimeActionsInstalled;
}

export function associationEventFinalizersInstalled(association: SessionAssociation): boolean {
	return associationState(association).runtimeEventFinalizersInstalled;
}

export function associationOwnsDefinition(
	association: SessionAssociation,
	definition: unknown,
): boolean {
	const state = associationState(association);
	return definition === state.definition && getTaggedInstaller(definition) === state.installer;
}

export function beginLifecycleInvocation(
	slotBySession: WeakMap<object, LifecycleSlot>,
	session: object,
	invocationKind: typeof BIND_INVOCATION_SLOT_KIND | typeof RELOAD_INVOCATION_SLOT_KIND,
): LifecycleInvocation {
	const currentSlot = slotBySession.get(session);
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
	slotBySession.set(session, invocation);
	return invocation;
}

export function invocationIsCurrent(
	state: PatchState,
	slotBySession: WeakMap<object, LifecycleSlot>,
	session: object,
	invocation: LifecycleInvocation,
): boolean {
	return state.active && slotBySession.get(session) === invocation;
}

export function publishSessionAssociation(
	slotBySession: WeakMap<object, LifecycleSlot>,
	session: object,
	invocation: LifecycleInvocation,
	installer: PiRuntimeInstaller,
	definition: object,
	parts: SessionParts,
): SessionAssociation | undefined {
	if (slotBySession.get(session) !== invocation) return undefined;
	const association: SessionAssociationState = {
		kind: ASSOCIATION_SLOT_KIND,
		installer,
		definition,
		parts,
		toolGeneration: INITIAL_TOOL_GENERATION,
		runtimeActionsInstalled: false,
		runtimeEventFinalizersInstalled: false,
	};
	slotBySession.set(session, association);
	return association as unknown as SessionAssociation;
}

export function installAssociationRuntimeActions(
	association: SessionAssociation,
	parts: SessionParts,
): void {
	const state = associationState(association);
	state.parts = parts;
	state.runtimeActionsInstalled = true;
}

export function refreshAssociationTools(
	association: SessionAssociation,
	parts: SessionParts,
): void {
	const state = associationState(association);
	state.parts = parts;
	state.toolGeneration += TOOL_GENERATION_INCREMENT;
}

export function restoreAssociationRuntimeActions(association: SessionAssociation): void {
	associationState(association).runtimeActionsInstalled = false;
}

export function installAssociationEventFinalizers(
	association: SessionAssociation,
	parts: SessionParts,
): void {
	const state = associationState(association);
	state.parts = parts;
	state.runtimeEventFinalizersInstalled = true;
}

export function restoreAssociationEventFinalizers(association: SessionAssociation): void {
	associationState(association).runtimeEventFinalizersInstalled = false;
}

export function clearCurrentSlot(
	slotBySession: WeakMap<object, LifecycleSlot>,
	session: object,
	expectedSlot: LifecycleSlot | SessionAssociation,
): void {
	const expectedState = expectedSlot as LifecycleSlot;
	const currentSlot = slotBySession.get(session);
	if (currentSlot === expectedState) {
		slotBySession.delete(session);
		return;
	}
	if (
		expectedState.kind === ASSOCIATION_SLOT_KIND &&
		currentSlot?.kind === RELOAD_INVOCATION_SLOT_KIND &&
		currentSlot.retainedAssociation === expectedState
	) {
		currentSlot.retainedAssociation = undefined;
	}
}

export function invocationOwnsSlotAtSettlement(
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

export function throwStaleCapture(
	_state: PatchState,
	slotBySession: WeakMap<object, LifecycleSlot>,
	session: object,
	association: SessionAssociation,
): never {
	clearCurrentSlot(slotBySession, session, association);
	throw new PiRuntimeCompatibilityError(PI_RUNTIME_DIAGNOSTICS.STALE_CAPTURE);
}

export function requireCurrentSessionParts(
	state: PatchState,
	slotBySession: WeakMap<object, LifecycleSlot>,
	session: object,
	association: SessionAssociation,
): SessionParts {
	const currentSlot = slotBySession.get(session);
	const expectedAssociation = association as unknown as object;
	const associationIsCurrent =
		currentSlot === expectedAssociation ||
		(currentSlot?.kind === RELOAD_INVOCATION_SLOT_KIND &&
			currentSlot.retainedAssociation === expectedAssociation);
	if (!state.active || !associationIsCurrent) {
		throwStaleCapture(state, slotBySession, session, association);
	}
	let validation: ReturnType<typeof validateSession>;
	try {
		validation = validateSession(session);
	} catch {
		throwStaleCapture(state, slotBySession, session, association);
	}
	const associationRecord = associationState(association);
	if (!validation.compatible || !sessionPartsMatch(validation.parts, associationRecord.parts)) {
		throwStaleCapture(state, slotBySession, session, association);
	}
	const expectedParts = associationRecord.parts;
	let definition: unknown;
	try {
		definition = Reflect.apply(expectedParts.getToolDefinition, session, [PTC_TOOL_NAME]);
	} catch {
		throwStaleCapture(state, slotBySession, session, association);
	}
	if (
		definition !== associationRecord.definition ||
		getTaggedInstaller(definition) !== associationRecord.installer
	) {
		throwStaleCapture(state, slotBySession, session, association);
	}
	return expectedParts;
}
