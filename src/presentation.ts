import { TRANSPORT_NAME } from "./config.ts";

export const COMPETING_TRANSPORT_NAMES = Object.freeze(["execute_tools", "fabric_exec", "retype"]);

export function hasCompetingOwner(registered: readonly string[]): boolean {
	return registered.some((name) => (COMPETING_TRANSPORT_NAMES as readonly string[]).includes(name));
}

export function resolveActiveTools(input: {
	logical: readonly string[];
	registered: readonly string[];
}): { tools: string[]; missingTransport: boolean } {
	const logical = input.logical.filter((name) => name !== TRANSPORT_NAME);
	if (!input.registered.includes(TRANSPORT_NAME)) {
		return { tools: logical, missingTransport: true };
	}
	return { tools: [TRANSPORT_NAME], missingTransport: false };
}
