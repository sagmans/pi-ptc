import type { EvalRun } from "./metrics.d.mts";

export function parseArguments(argv: string[]): {
	config?: string;
	dryRun: boolean;
	run: boolean;
	resumeDirectory?: string;
};
export function buildDryRun(
	configValue: unknown,
	configPath: string | URL,
): Promise<{
	configPath: string;
	runs: Array<EvalRun & { key: string }>;
	providerCalls: number;
	costUsd: number;
}>;
