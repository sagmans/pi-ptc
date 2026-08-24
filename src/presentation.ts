// Presentation owns the model-facing tool set. It never invents core tools
// the session did not already have.

import { isCoreToolName, type Presentation, TRANSPORT_NAME } from "./config.ts";

export const COMPETING_TRANSPORT_NAMES = Object.freeze(["execute_tools", "fabric_exec", "retype"]);

export function hasCompetingOwner(registered: readonly string[]): boolean {
	return registered.some((name) => (COMPETING_TRANSPORT_NAMES as readonly string[]).includes(name));
}

export function applyPresentation(input: {
	presentation: Presentation;
	recorded: readonly string[];
}): string[] {
	const core = input.recorded.filter((name) => isCoreToolName(name));
	const foreign = input.recorded.filter((name) => name !== TRANSPORT_NAME && !isCoreToolName(name));
	if (input.presentation === "native") return [...core, ...foreign];
	if (input.presentation === "both") return [...core, ...foreign, TRANSPORT_NAME];
	return [...foreign, TRANSPORT_NAME];
}

export function resolveActiveTools(input: {
	presentation: Presentation;
	recorded: readonly string[];
	registered: readonly string[];
}): { tools: string[]; missingTransport: boolean } {
	if (input.presentation !== "native" && !input.registered.includes(TRANSPORT_NAME)) {
		return {
			tools: applyPresentation({ presentation: "native", recorded: input.recorded }),
			missingTransport: true,
		};
	}
	return {
		tools: applyPresentation({
			presentation: input.presentation,
			recorded: input.recorded,
		}),
		missingTransport: false,
	};
}
