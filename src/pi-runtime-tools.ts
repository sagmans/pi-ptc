import type { PiRuntimeTool } from "./pi-runtime-contract.ts";
import { PI_RUNTIME_DIAGNOSTICS } from "./pi-runtime-contract.ts";
import type { SessionParts, ToolSnapshot } from "./pi-runtime-registry.ts";
import { PiRuntimeCompatibilityError } from "./pi-runtime-registry.ts";

export function createGuardedIterator<T>(
	validate: () => SessionParts,
	length: number,
	valueAt: (index: number) => T,
): IterableIterator<T> {
	let index = 0;
	const iterator: IterableIterator<T> = {
		next(): IteratorResult<T> {
			validate();
			if (index >= length) return { done: true, value: undefined };
			const value = valueAt(index);
			index += 1;
			return { done: false, value };
		},
		[Symbol.iterator](): IterableIterator<T> {
			validate();
			return iterator;
		},
	};
	return Object.freeze(iterator);
}

export function createToolFacade(
	validate: () => SessionParts,
	snapshot: ToolSnapshot,
): PiRuntimeTool {
	const prepareArguments = snapshot.prepareArguments
		? (args: unknown): unknown => {
				validate();
				return Reflect.apply(
					snapshot.prepareArguments as (args: unknown) => unknown,
					snapshot.entry,
					[args],
				);
			}
		: undefined;
	return Object.freeze({
		get parameters(): object {
			validate();
			return snapshot.parameters;
		},
		get prepareArguments(): ((args: unknown) => unknown) | undefined {
			validate();
			return prepareArguments;
		},
		get executionMode(): "parallel" | "sequential" | undefined {
			validate();
			return snapshot.executionMode;
		},
		execute(
			toolCallId: string,
			params: unknown,
			signal?: AbortSignal,
			onUpdate?: (partialResult: unknown) => void,
		): Promise<unknown> {
			validate();
			return Reflect.apply(snapshot.execute, snapshot.entry, [
				toolCallId,
				params,
				signal,
				onUpdate,
			]);
		},
	});
}

export function createToolRegistryFacade(
	validate: () => SessionParts,
	toolSnapshots: readonly ToolSnapshot[],
): ReadonlyMap<string, PiRuntimeTool> {
	const toolsByName = new Map(
		toolSnapshots.map((snapshot) => [snapshot.name, createToolFacade(validate, snapshot)]),
	);
	let facade: ReadonlyMap<string, PiRuntimeTool>;
	const implementation = {
		get size(): number {
			validate();
			return toolSnapshots.length;
		},
		get(name: string): PiRuntimeTool | undefined {
			validate();
			return toolsByName.get(name);
		},
		has(name: string): boolean {
			validate();
			return toolsByName.has(name);
		},
		forEach(
			callback: (
				value: PiRuntimeTool,
				key: string,
				map: ReadonlyMap<string, PiRuntimeTool>,
			) => void,
			thisArg?: unknown,
		): void {
			validate();
			for (const snapshot of toolSnapshots) {
				validate();
				Reflect.apply(callback, thisArg, [toolsByName.get(snapshot.name), snapshot.name, facade]);
			}
		},
		entries(): IterableIterator<[string, PiRuntimeTool]> {
			validate();
			return createGuardedIterator(validate, toolSnapshots.length, (index) => {
				const snapshot = toolSnapshots[index];
				if (!snapshot) throw new PiRuntimeCompatibilityError(PI_RUNTIME_DIAGNOSTICS.STALE_CAPTURE);
				return [snapshot.name, toolsByName.get(snapshot.name) as PiRuntimeTool];
			});
		},
		keys(): IterableIterator<string> {
			validate();
			return createGuardedIterator(validate, toolSnapshots.length, (index) => {
				const snapshot = toolSnapshots[index];
				if (!snapshot) throw new PiRuntimeCompatibilityError(PI_RUNTIME_DIAGNOSTICS.STALE_CAPTURE);
				return snapshot.name;
			});
		},
		values(): IterableIterator<PiRuntimeTool> {
			validate();
			return createGuardedIterator(validate, toolSnapshots.length, (index) => {
				const snapshot = toolSnapshots[index];
				if (!snapshot) throw new PiRuntimeCompatibilityError(PI_RUNTIME_DIAGNOSTICS.STALE_CAPTURE);
				return toolsByName.get(snapshot.name) as PiRuntimeTool;
			});
		},
		[Symbol.iterator](): IterableIterator<[string, PiRuntimeTool]> {
			validate();
			return implementation.entries();
		},
	};
	facade = Object.freeze(implementation) as unknown as ReadonlyMap<string, PiRuntimeTool>;
	return facade;
}
