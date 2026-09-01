import type { PiRuntimeInstaller } from "./pi-runtime-contract.ts";
import { PI_RUNTIME_DIAGNOSTICS } from "./pi-runtime-contract.ts";
import type {
	LifecycleInvocation,
	LifecycleSlot,
	PatchState,
	SessionAssociation,
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
	const association: SessionAssociation = {
		kind: ASSOCIATION_SLOT_KIND,
		installer,
		definition,
		parts,
		toolGeneration: INITIAL_TOOL_GENERATION,
		runtimeActionsInstalled: false,
		runtimeEventFinalizersInstalled: false,
	};
	slotBySession.set(session, association);
	return association;
}

export function installAssociationRuntimeActions(
	association: SessionAssociation,
	parts: SessionParts,
): void {
	association.parts = parts;
	association.runtimeActionsInstalled = true;
}

export function refreshAssociationTools(
	association: SessionAssociation,
	parts: SessionParts,
): void {
	association.parts = parts;
	association.toolGeneration += TOOL_GENERATION_INCREMENT;
}

export function restoreAssociationRuntimeActions(association: SessionAssociation): void {
	association.runtimeActionsInstalled = false;
}

export function installAssociationEventFinalizers(
	association: SessionAssociation,
	parts: SessionParts,
): void {
	association.parts = parts;
	association.runtimeEventFinalizersInstalled = true;
}

export function restoreAssociationEventFinalizers(association: SessionAssociation): void {
	association.runtimeEventFinalizersInstalled = false;
}

export function clearCurrentSlot(
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
