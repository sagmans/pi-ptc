import { type Presentation, TRANSPORT_NAME } from "./config.ts";
import type {
	CapturedPiSession,
	PiRuntimeActionsInstallation,
	PiRuntimeToolEntry,
} from "./pi-runtime.ts";
import { resolveActiveTools } from "./presentation.ts";

const RESTORED_CATALOG_MESSAGE = "Tool catalog is restored";

export type ToolCatalogEntry = PiRuntimeToolEntry;

export type ToolCatalog = {
	getLogicalActiveTools(): string[];
	snapshot(): readonly ToolCatalogEntry[];
	applyPhysical(): { missingTransport: boolean };
	activateAvailable(names: readonly string[]): readonly string[];
	restore(): void;
};

export type ToolCatalogRefreshFailure = {
	readonly refreshError: unknown;
	readonly rollbackFailed: boolean;
	readonly rollbackError: unknown;
	readonly previousLogicalActiveTools: readonly string[];
};

export type CreateToolCatalogOptions = {
	session: CapturedPiSession;
	getPresentation(): Presentation;
	onRefreshFailure?(failure: ToolCatalogRefreshFailure): void;
};

function compareNames(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function uniqueAvailableNames(
	names: readonly string[],
	available: ReadonlyMap<string, ToolCatalogEntry>,
): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const name of names) {
		if (name === TRANSPORT_NAME || seen.has(name) || !available.has(name)) continue;
		seen.add(name);
		result.push(name);
	}
	return result;
}

export function createToolCatalog(options: CreateToolCatalogOptions): ToolCatalog {
	const initialRegistry = options.session.toolRegistry;
	let entriesByName = new Map<string, ToolCatalogEntry>();
	for (const [name, executable] of initialRegistry) {
		entriesByName.set(name, {
			name,
			executable,
			definition: options.session.getToolDefinition(name),
		});
	}
	let logicalActiveTools = uniqueAvailableNames(
		options.session.sharedRuntime.getActiveTools(),
		entriesByName,
	);
	let restored = false;
	let runtimeInstallation: PiRuntimeActionsInstallation | undefined;

	const requireActive = (): PiRuntimeActionsInstallation => {
		if (restored || !runtimeInstallation) throw new Error(RESTORED_CATALOG_MESSAGE);
		return runtimeInstallation;
	};
	const deactivate = (activeToolNames: readonly string[]): void => {
		if (restored) return;
		try {
			runtimeInstallation?.restore(activeToolNames);
		} finally {
			restored = true;
			runtimeInstallation = undefined;
			entriesByName.clear();
			logicalActiveTools = [];
		}
	};
	const replaceEntries = (entries: readonly ToolCatalogEntry[]): void => {
		entriesByName = new Map(entries.map((entry) => [entry.name, entry]));
	};
	const resolvePresentation = (
		logical: readonly string[],
	): { tools: string[]; missingTransport: boolean } =>
		resolveActiveTools({
			presentation: options.getPresentation(),
			logical,
			registered: [...entriesByName.keys()],
		});
	const getVirtualActiveTools = (): string[] => {
		const presentation = options.getPresentation();
		if (presentation === "native" || !entriesByName.has(TRANSPORT_NAME)) {
			return [...logicalActiveTools];
		}
		return [...logicalActiveTools, TRANSPORT_NAME];
	};
	const applyPhysical = (): { missingTransport: boolean } => {
		const installation = requireActive();
		const resolved = resolvePresentation(logicalActiveTools);
		installation.original.setActiveTools(resolved.tools);
		return { missingTransport: resolved.missingTransport };
	};

	runtimeInstallation = options.session.installRuntimeActions({
		getActiveTools(): string[] {
			requireActive();
			return getVirtualActiveTools();
		},
		setActiveTools(toolNames: string[]): void {
			requireActive();
			logicalActiveTools = uniqueAvailableNames(toolNames, entriesByName);
			applyPhysical();
		},
		refreshTools(): void {
			const installation = requireActive();
			const previousLogical = Object.freeze([...logicalActiveTools]);
			const previousRegistryNames = new Set(entriesByName.keys());
			try {
				installation.original.refreshTools();
				const rawActiveTools = installation.original.getActiveTools();
				const refreshedEntries = installation.original.snapshotTools();
				replaceEntries(refreshedEntries);
				const preserved = uniqueAvailableNames(previousLogical, entriesByName);
				const preservedNames = new Set(preserved);
				const adopted = rawActiveTools.filter(
					(name) =>
						name !== TRANSPORT_NAME &&
						!previousRegistryNames.has(name) &&
						!preservedNames.has(name) &&
						entriesByName.has(name),
				);
				logicalActiveTools = uniqueAvailableNames([...preserved, ...adopted], entriesByName);
				applyPhysical();
			} catch (error) {
				let rollbackFailed = false;
				let rollbackError: unknown;
				try {
					deactivate(previousLogical);
				} catch (restoreError) {
					rollbackFailed = true;
					rollbackError = restoreError;
				}
				const failure: ToolCatalogRefreshFailure = Object.freeze({
					refreshError: error,
					rollbackFailed,
					rollbackError,
					previousLogicalActiveTools: previousLogical,
				});
				try {
					options.onRefreshFailure?.(failure);
				} catch {}
				throw error;
			}
		},
	});
	try {
		replaceEntries(runtimeInstallation.original.snapshotTools());
		logicalActiveTools = uniqueAvailableNames(logicalActiveTools, entriesByName);
	} catch (error) {
		runtimeInstallation.restore();
		restored = true;
		runtimeInstallation = undefined;
		throw error;
	}

	return Object.freeze({
		getLogicalActiveTools(): string[] {
			requireActive();
			return [...logicalActiveTools];
		},
		snapshot(): readonly ToolCatalogEntry[] {
			requireActive();
			return Object.freeze(
				logicalActiveTools
					.map((name) => entriesByName.get(name))
					.filter((entry): entry is ToolCatalogEntry => entry !== undefined)
					.sort((left, right) => compareNames(left.name, right.name)),
			);
		},
		applyPhysical,
		activateAvailable(names: readonly string[]): readonly string[] {
			const installation = requireActive();
			const previous = logicalActiveTools;
			const previousNames = new Set(previous);
			const candidate = uniqueAvailableNames([...previous, ...names], entriesByName);
			try {
				installation.original.setActiveTools(resolvePresentation(candidate).tools);
			} catch (error) {
				try {
					installation.original.setActiveTools(resolvePresentation(previous).tools);
				} catch {}
				throw error;
			}
			logicalActiveTools = candidate;
			return Object.freeze(candidate.filter((name) => !previousNames.has(name)));
		},
		restore(): void {
			deactivate(logicalActiveTools);
		},
	});
}
