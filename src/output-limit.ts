export const LOG_OUTPUT_SUBJECT = "log output";
export const MAX_OUTPUT_BYTES_NAME = "maxOutputBytes";
export const MAX_OUTPUT_LINES_NAME = "maxOutputLines";
export const OUTER_RESULT_SUBJECT = "outer result";
export const PROGRAM_RESULT_SUBJECT = "program result";
export const WORKER_ERROR_SUBJECT = "worker error message";
export const WORKER_FAILURE_SUBJECT = "worker failure message";

const OUTPUT_LIMIT_NAMES = [MAX_OUTPUT_BYTES_NAME, MAX_OUTPUT_LINES_NAME] as const;
const OUTPUT_LIMIT_SUBJECTS = [
	LOG_OUTPUT_SUBJECT,
	OUTER_RESULT_SUBJECT,
	PROGRAM_RESULT_SUBJECT,
	WORKER_ERROR_SUBJECT,
	WORKER_FAILURE_SUBJECT,
] as const;

export type OutputLimitName = (typeof OUTPUT_LIMIT_NAMES)[number];
export type OutputLimitSubject = (typeof OUTPUT_LIMIT_SUBJECTS)[number];

export function isOutputLimitName(value: unknown): value is OutputLimitName {
	return OUTPUT_LIMIT_NAMES.some((name) => value === name);
}

export function isOutputLimitSubject(value: unknown): value is OutputLimitSubject {
	return OUTPUT_LIMIT_SUBJECTS.some((subject) => value === subject);
}

export function describe(
	subject: OutputLimitSubject,
	limitName: OutputLimitName,
	observed: number,
	limit: number,
): string {
	return `${subject} exceeds ${limitName}: ${observed} > ${limit}`;
}
