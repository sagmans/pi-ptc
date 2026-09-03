export type LargeScaleTextEditingResult = {
	correct: boolean;
	reason: string;
	keystrokes?: number;
};

export function materializeLargeScaleTextEditing(
	directory: string,
	rowCount: number,
): Promise<void>;
export function validateLargeScaleTextEditingScript(
	text: string,
): { ok: false; reason: string } | { ok: true; definitions: string[] };
export function judgeLargeScaleTextEditing(
	directory: string,
	rowCount: number,
): Promise<LargeScaleTextEditingResult>;
