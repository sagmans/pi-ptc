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
	restore(): void;
};

export type CreateToolCatalogOptions = {
	session: CapturedPiSession;
	getPresentation(): Presentation;
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
	const replaceEntries = (entries: readonly ToolCatalogEntry[]): void => {
		entriesByName = new Map(entries.map((entry) => [entry.name, entry]));
	};
	const resolveCurrentPresentation = (): { tools: string[]; missingTransport: boolean } =>
		resolveActiveTools({
			presentation: options.getPresentation(),
			logical: logicalActiveTools,
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
		const resolved = resolveCurrentPresentation();
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
			const previousLogical = [...logicalActiveTools];
			const previousRegistryNames = new Set(entriesByName.keys());
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
		restore(): void {
			if (restored) return;
			try {
				runtimeInstallation?.restore(logicalActiveTools);
			} finally {
				restored = true;
				runtimeInstallation = undefined;
				entriesByName.clear();
				logicalActiveTools = [];
			}
		},
	});
}
