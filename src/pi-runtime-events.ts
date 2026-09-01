import {
	associationEventFinalizersInstalled,
	clearCurrentSlot,
	installAssociationEventFinalizers,
	requireCurrentSessionParts,
	restoreAssociationEventFinalizers,
	throwStaleCapture,
} from "./pi-runtime-association.ts";
import type {
	PiRuntimeEventFinalizers,
	PiRuntimeEventFinalizersInstallation,
} from "./pi-runtime-contract.ts";
import { diagnostic, PI_RUNTIME_DIAGNOSTICS } from "./pi-runtime-contract.ts";
import type {
	LifecycleSlot,
	PatchState,
	RunnerEventMethod,
	RunnerEventProperty,
	SessionAssociation,
	SessionParts,
} from "./pi-runtime-registry.ts";
import {
	EMIT_TOOL_CALL_PROPERTY,
	PiRuntimeCompatibilityError,
	RESTORE_INHERITED_EVENT_METHOD_ERROR_PREFIX,
	RUNTIME_EVENT_PROPERTIES,
} from "./pi-runtime-registry.ts";
import {
	inheritedRunnerEventSourcesMatch,
	sessionPartsMatchWithRuntimeEventFinalizers,
	validateRuntimeEventFinalizers,
	validateSession,
} from "./pi-runtime-shape.ts";

export function installCapturedRuntimeEventFinalizers(
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
	if (associationEventFinalizersInstalled(association)) {
		throw new PiRuntimeCompatibilityError(
			PI_RUNTIME_DIAGNOSTICS.RUNTIME_EVENT_FINALIZERS_ALREADY_INSTALLED,
		);
	}
	const originalShapes = initialParts.eventMethods;
	let restored = false;
	let installed = false;
	const wrappers = {} as Record<RunnerEventProperty, RunnerEventMethod>;
	const requireInstalledParts = (): SessionParts => {
		if (restored || !installed || !associationEventFinalizersInstalled(association)) {
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
	installAssociationEventFinalizers(association, validation.parts);
	installed = true;

	return Object.freeze({
		restore(): void {
			if (restored) return;
			restored = true;
			installed = false;
			restoreAssociationEventFinalizers(association);
			const restoreError = restoreOwnedWrappers();
			clearCurrentSlot(slotBySession, session, association);
			if (restoreError) throw restoreError;
		},
	});
}
