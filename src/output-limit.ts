export const LOG_OUTPUT_SUBJECT = "log output";
export const MAX_OUTPUT_BYTES_NAME = "maxOutputBytes";
export const MAX_OUTPUT_LINES_NAME = "maxOutputLines";
export const PROGRAM_RESULT_SUBJECT = "program result";
export const WORKER_ERROR_SUBJECT = "worker error message";
export const WORKER_FAILURE_SUBJECT = "worker failure message";

export type OutputLimitName = typeof MAX_OUTPUT_BYTES_NAME | typeof MAX_OUTPUT_LINES_NAME;

export function describe(
	subject: string,
	limitName: OutputLimitName,
	observed: number,
	limit: number,
): string {
	return `${subject} exceeds ${limitName}: ${observed} > ${limit}`;
}
