import { createPiToolArgumentPreparer } from "./pi-runtime-arguments.ts";
import type {
	CapturedPiSession,
	PiRuntimeTool,
	PiToolArgumentPreparation,
} from "./pi-runtime-contract.ts";
import { PI_RUNTIME_DIAGNOSTICS } from "./pi-runtime-contract.ts";
import { isSupportedPiVersion } from "./pi-runtime-version.ts";

const ITERATOR_PROPERTY = Symbol.iterator;

type LegacyCapturedPiSession = Omit<CapturedPiSession, "prepareToolArguments"> & {
	prepareToolArguments?: CapturedPiSession["prepareToolArguments"];
};

function hasLegacyContract(session: LegacyCapturedPiSession): boolean {
	const registry = session.toolRegistry as ReadonlyMap<string, PiRuntimeTool> & {
		[ITERATOR_PROPERTY]?: unknown;
	};
	return (
		isSupportedPiVersion(session.version) &&
		typeof registry?.get === "function" &&
		typeof registry?.[ITERATOR_PROPERTY] === "function" &&
		typeof session.beforeToolCall === "function" &&
		typeof session.afterToolCall === "function" &&
		typeof session.getToolDefinition === "function" &&
		typeof session.installRuntimeActions === "function" &&
		typeof session.installRuntimeEventFinalizers === "function"
	);
}

export function adaptLegacyCapturedPiSession(
	session: CapturedPiSession,
): CapturedPiSession | undefined {
	const legacy = session as unknown as LegacyCapturedPiSession;
	if (typeof legacy.prepareToolArguments === "function") return session;
	try {
		if (!hasLegacyContract(legacy)) return undefined;
		const initialPreparer = createPiToolArgumentPreparer(new Map(legacy.toolRegistry));
		const capturedVersion = legacy.version;
		const validate = (): void => {
			if (legacy.version !== capturedVersion || !isSupportedPiVersion(legacy.version)) {
				throw new Error(PI_RUNTIME_DIAGNOSTICS.STALE_CAPTURE);
			}
		};
		const prepareToolArguments = (
			toolName: string,
			rawArguments: unknown,
			tool?: PiRuntimeTool,
		): PiToolArgumentPreparation => {
			validate();
			return tool
				? createPiToolArgumentPreparer(new Map([[toolName, tool]]))(toolName, rawArguments)
				: initialPreparer(toolName, rawArguments);
		};
		return Object.freeze({
			get version() {
				return legacy.version;
			},
			get extensionRunner() {
				validate();
				return legacy.extensionRunner;
			},
			get sharedRuntime() {
				validate();
				return legacy.sharedRuntime;
			},
			get toolRegistry() {
				validate();
				return legacy.toolRegistry;
			},
			get beforeToolCall() {
				validate();
				return legacy.beforeToolCall;
			},
			get afterToolCall() {
				validate();
				return legacy.afterToolCall;
			},
			getToolDefinition: (name: string) => legacy.getToolDefinition(name),
			prepareToolArguments,
			installRuntimeActions: (replacements) => legacy.installRuntimeActions(replacements),
			installRuntimeEventFinalizers: (finalizers) =>
				legacy.installRuntimeEventFinalizers(finalizers),
		});
	} catch {
		return undefined;
	}
}
