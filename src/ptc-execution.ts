import { DISPATCH_LOG_TYPE } from "./config.ts";
import type { DispatchLogEntry, DispatchProgress } from "./dispatch-contract.ts";
import type { ExtensionAPI, ExtensionContext } from "./host.ts";
import type { PtcExecutionLease } from "./ptc-tool-contract.ts";
import { createPtcDefinitionRegistry } from "./renderer.ts";
import { createScheduler } from "./scheduler.ts";
import { createToolBindings } from "./tool-bindings.ts";
import { createToolExecutor } from "./tool-executor.ts";

const PTC_RUNTIME_UNAVAILABLE_MESSAGE = "ptc runtime capture is unavailable";

export type CreatePtcExecutionOptions = {
	readonly lease: PtcExecutionLease;
	readonly maxParallelDispatches: number;
	readonly context: {
		readonly isOpen: () => boolean;
		readonly reportDispatch?: (progress: DispatchProgress) => void;
	};
	readonly pi: ExtensionAPI;
	readonly lastContext?: ExtensionContext;
};

export function createPtcExecution(options: CreatePtcExecutionOptions) {
	try {
		options.lease.assertCurrent();
		const snapshot = options.lease.catalog;
		const executor = createToolExecutor({
			catalog: snapshot,
			session: options.lease.session,
			activateTools(names) {
				options.lease.activateAvailable(names);
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
		options.lease.transitionToInert(error, options.lastContext);
		throw new Error(PTC_RUNTIME_UNAVAILABLE_MESSAGE);
	}
}
