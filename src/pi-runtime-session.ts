import { installCapturedRuntimeActions } from "./pi-runtime-actions.ts";
import { clearCurrentSlot, requireCurrentSessionParts } from "./pi-runtime-association.ts";
import type {
	CapturedPiSession,
	PiExtensionRunner,
	PiRuntimeActionsInstallation,
	PiRuntimeEventFinalizers,
	PiRuntimeEventFinalizersInstallation,
	PiRuntimeTool,
	PiSharedRuntime,
} from "./pi-runtime-contract.ts";
import { PI_RUNTIME_DIAGNOSTICS, SUPPORTED_PI_VERSION } from "./pi-runtime-contract.ts";
import { installCapturedRuntimeEventFinalizers } from "./pi-runtime-events.ts";
import type {
	LifecycleInvocation,
	LifecycleSlot,
	PatchState,
	SessionAssociation,
	SessionParts,
} from "./pi-runtime-registry.ts";
import {
	ASSOCIATION_SLOT_KIND,
	GET_TOOL_DEFINITION_PROPERTY,
	incompatible,
	isRecord,
	PiRuntimeCompatibilityError,
	PTC_TOOL_NAME,
} from "./pi-runtime-registry.ts";
import { createTransportOwnership, getTaggedInstaller } from "./pi-runtime-registry-validation.ts";
import { validateSession } from "./pi-runtime-shape.ts";
import { createToolRegistryFacade } from "./pi-runtime-tools.ts";

export function createCapturedSession(
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

export function inspectBoundSession(
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
	const transportOwnership = createTransportOwnership(
		session,
		session[GET_TOOL_DEFINITION_PROPERTY] as (name: string) => unknown,
		definition as object,
		installer,
	);
	const validation = validateSession(session);
	if (!validation.compatible) {
		try {
			installer.capturePiRuntime(incompatible(validation.diagnostic, transportOwnership));
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
			transportOwnership,
		});
	} catch (error) {
		clearCurrentSlot(slotBySession, session, association);
		throw error;
	}
}
