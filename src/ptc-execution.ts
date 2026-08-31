import { DISPATCH_LOG_TYPE, TRANSPORT_NAME } from "./config.ts";
import type { DispatchLogEntry, DispatchProgress } from "./dispatch-contract.ts";
import type { ExtensionAPI, ExtensionContext } from "./host.ts";
import type { CapturedPiSession } from "./pi-runtime.ts";
import { createPtcDefinitionRegistry } from "./renderer.ts";
import { createScheduler } from "./scheduler.ts";
import { createToolBindings } from "./tool-bindings.ts";
import type { ToolCatalog } from "./tool-catalog.ts";
import { createToolExecutor } from "./tool-executor.ts";

const PTC_RUNTIME_UNAVAILABLE_MESSAGE = "ptc runtime capture is unavailable";

export type CreatePtcExecutionOptions = {
	readonly catalog: ToolCatalog;
	readonly session: CapturedPiSession;
	readonly maxParallelDispatches: number;
	readonly context: {
		readonly isOpen: () => boolean;
		readonly reportDispatch?: (progress: DispatchProgress) => void;
	};
	readonly pi: ExtensionAPI;
	isCurrent(): boolean;
	onFailure(error: unknown, context?: ExtensionContext): void;
	readonly lastContext?: ExtensionContext;
};

export function createPtcExecution(options: CreatePtcExecutionOptions) {
	let snapshot: ReturnType<ToolCatalog["snapshot"]>;
	try {
		snapshot = options.catalog.snapshot();
	} catch (error) {
		options.onFailure(error, options.lastContext);
		throw new Error(PTC_RUNTIME_UNAVAILABLE_MESSAGE);
	}
	try {
		const executor = createToolExecutor({
			catalog: snapshot,
			session: options.session,
			activateTools(names) {
				if (!options.isCurrent()) return;
				try {
					options.catalog.activateAvailable(
						names.filter(
							(name): name is string => typeof name === "string" && name !== TRANSPORT_NAME,
						),
					);
				} catch (error) {
					options.onFailure(error, options.lastContext);
					throw new Error(PTC_RUNTIME_UNAVAILABLE_MESSAGE);
				}
			},
		});
		return {
			definitions: createPtcDefinitionRegistry(snapshot),
			bindings: createToolBindings(
				snapshot,
				executor,
				createScheduler(options.maxParallelDispatches),
				{
					acceptSideEffects: options.context.isOpen,
					appendLog: (entry: DispatchLogEntry) => {
						options.pi.appendEntry(DISPATCH_LOG_TYPE, entry);
					},
					emit: (name, payload) => {
						options.pi.events.emit(name, payload);
					},
					reportDispatch: options.context.reportDispatch,
				},
			),
		};
	} catch (error) {
		options.onFailure(error, options.lastContext);
		throw new Error(PTC_RUNTIME_UNAVAILABLE_MESSAGE);
	}
}
