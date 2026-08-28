import { type Presentation, TRANSPORT_NAME } from "./config.ts";

export const COMPETING_TRANSPORT_NAMES = Object.freeze(["execute_tools", "fabric_exec", "retype"]);

export function hasCompetingOwner(registered: readonly string[]): boolean {
	return registered.some((name) => (COMPETING_TRANSPORT_NAMES as readonly string[]).includes(name));
}

export function applyPresentation(input: {
	presentation: Presentation;
	logical: readonly string[];
}): string[] {
	const logical = input.logical.filter((name) => name !== TRANSPORT_NAME);
	if (input.presentation === "native") return logical;
	if (input.presentation === "both") return [...logical, TRANSPORT_NAME];
	return [TRANSPORT_NAME];
}

export function resolveActiveTools(input: {
	presentation: Presentation;
	logical: readonly string[];
	registered: readonly string[];
}): { tools: string[]; missingTransport: boolean } {
	if (input.presentation !== "native" && !input.registered.includes(TRANSPORT_NAME)) {
		return {
			tools: applyPresentation({ presentation: "native", logical: input.logical }),
			missingTransport: true,
		};
	}
	return {
		tools: applyPresentation({
			presentation: input.presentation,
			logical: input.logical,
		}),
		missingTransport: false,
	};
}
