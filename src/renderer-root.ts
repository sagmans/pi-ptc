import type { PtcPersistedDispatch } from "./dispatch-details.ts";
import type {
	PtcDefinitionRegistry,
	PtcImageServices,
	PtcRendererRoot,
	PtcRowView,
} from "./renderer-contract.ts";
import {
	DISPLAY_DIAGNOSTIC_NAME,
	EXECUTION_TOOL_NAME,
	errorMessage,
	PtcDiagnosticRow,
	renderRootFailure,
	sanitizeDiagnostic,
} from "./renderer-diagnostics.ts";
import { PtcDispatchRow } from "./renderer-row.ts";

const NESTED_TOOL_CALL_SEPARATOR = ":dispatch:";

export class SafePtcRoot implements PtcRendererRoot {
	readonly cwd: string;
	private readonly definitions: PtcDefinitionRegistry;
	private readonly imageServices: PtcImageServices;
	private readonly rows = new Map<number, PtcDispatchRow>();
	private readonly orderedRows: PtcDispatchRow[] = [];
	private compatibilityError: PtcDiagnosticRow | undefined;
	private containedFailure: string | undefined;
	private executionError: PtcDiagnosticRow | undefined;
	private readonly toolCallId: string;
	private view: PtcRowView;

	constructor(
		cwd: string,
		toolCallId: string,
		view: PtcRowView,
		definitions: PtcDefinitionRegistry,
		imageServices: PtcImageServices,
	) {
		this.cwd = cwd;
		this.toolCallId = toolCallId;
		this.view = view;
		this.definitions = definitions;
		this.imageServices = imageServices;
	}

	setView(view: PtcRowView): void {
		try {
			const visualStateChanged =
				this.view.expanded !== view.expanded ||
				this.view.showImages !== view.showImages ||
				this.view.theme !== view.theme;
			this.view.expanded = view.expanded;
			this.view.showImages = view.showImages;
			this.view.theme = view.theme;
			this.view.invalidate = view.invalidate;
			if (!visualStateChanged) return;
			for (const row of this.orderedRows) row.setView(this.view);
			this.compatibilityError?.setView(this.view);
			this.executionError?.setView(this.view);
		} catch (error) {
			this.contain(error);
		}
	}

	updateDispatch(dispatch: PtcPersistedDispatch): void {
		try {
			let row = this.rows.get(dispatch.id);
			if (!row) {
				row = new PtcDispatchRow({
					cwd: this.cwd,
					definition: this.definitions[dispatch.name],
					dispatch,
					imageServices: this.imageServices,
					toolCallId: `${this.toolCallId}${NESTED_TOOL_CALL_SEPARATOR}${dispatch.id}`,
					view: this.view,
				});
				this.rows.set(dispatch.id, row);
				const lastRow = this.orderedRows.at(-1);
				if (!lastRow || lastRow.id < dispatch.id) {
					this.orderedRows.push(row);
				} else {
					this.orderedRows.splice(findRowInsertionIndex(this.orderedRows, dispatch.id), 0, row);
				}
				return;
			}
			row.update(dispatch);
		} catch (error) {
			this.contain(error);
		}
	}

	setCompatibilityError(message: string | undefined): void {
		this.compatibilityError = this.updateDiagnostic(
			this.compatibilityError,
			DISPLAY_DIAGNOSTIC_NAME,
			message,
		);
	}

	setExecutionError(message: string | undefined): void {
		this.executionError = this.updateDiagnostic(this.executionError, EXECUTION_TOOL_NAME, message);
	}

	contain(error: unknown): void {
		this.containedFailure = sanitizeDiagnostic(errorMessage(error));
	}

	unmount(): void {
		for (const row of this.orderedRows) row.unmount();
	}

	invalidate(): void {
		try {
			for (const row of this.orderedRows) row.invalidate();
			this.compatibilityError?.invalidate();
			this.executionError?.invalidate();
		} catch (error) {
			this.contain(error);
		}
	}

	render(width: number): string[] {
		if (this.containedFailure) {
			return renderRootFailure(this.containedFailure, width, this.view.theme);
		}
		try {
			const lines: string[] = [];
			for (const row of this.orderedRows) lines.push(...row.render(width));
			if (this.compatibilityError) lines.push(...this.compatibilityError.render(width));
			if (this.executionError) lines.push(...this.executionError.render(width));
			return lines;
		} catch (error) {
			this.contain(error);
			return renderRootFailure(error, width, this.view.theme);
		}
	}

	private updateDiagnostic(
		current: PtcDiagnosticRow | undefined,
		label: string,
		message: string | undefined,
	): PtcDiagnosticRow | undefined {
		try {
			if (message === undefined) return undefined;
			const diagnostic = current ?? new PtcDiagnosticRow(label, this.view);
			diagnostic.setMessage(message);
			return diagnostic;
		} catch (error) {
			this.contain(error);
			return undefined;
		}
	}
}

function findRowInsertionIndex(rows: readonly PtcDispatchRow[], id: number): number {
	let low = 0;
	let high = rows.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if ((rows[middle]?.id ?? id) < id) low = middle + 1;
		else high = middle;
	}
	return low;
}
