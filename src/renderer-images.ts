import { createHash } from "node:crypto";

import { type Component, type ImageProtocol, Spacer } from "@earendil-works/pi-tui";

import type { PtcPersistedRenderResult } from "./dispatch-details.ts";
import type { PtcImageServices, PtcRowView } from "./renderer-contract.ts";
import { ROW_SPACING } from "./renderer-diagnostics.ts";

const IMAGE_HASH_ALGORITHM = "sha256";
const IMAGE_KEY_SEPARATOR = "\u0000";
const IMAGE_PNG_MIME_TYPE = "image/png";
const MINIMUM_IMAGE_WIDTH_CELLS = 1;

type PtcImageSource = {
	data: string;
	mimeType: string;
};

type PtcImageRecord = {
	component?: Component;
	componentWidth?: number;
	conversion?: Promise<{ data: string; mimeType: string } | null>;
	converted?: PtcImageSource;
	generation: number;
	key: string;
	source: PtcImageSource;
};

type ImageBlock = PtcPersistedRenderResult["content"][number] & {
	data: string;
	mimeType: string;
};

type PtcImageCollectionInput = {
	services: PtcImageServices;
	getView(): PtcRowView;
	contain(error: unknown): void;
	requestInvalidate(): void;
};

export class PtcImageCollection {
	private cache = new Map<string, PtcImageRecord>();
	private readonly input: PtcImageCollectionInput;
	private generation = 0;
	private mounted = true;
	private order: PtcImageRecord[] = [];

	constructor(input: PtcImageCollectionInput) {
		this.input = input;
	}

	advanceGeneration(): void {
		this.generation += 1;
	}

	clear(): void {
		this.cache.clear();
		this.order = [];
	}

	unmount(): void {
		this.mounted = false;
		this.advanceGeneration();
		this.clear();
	}

	invalidateComponents(): void {
		for (const image of this.order) {
			image.component = undefined;
			image.componentWidth = undefined;
		}
	}

	invalidateRenderedComponents(): void {
		for (const image of this.order) image.component?.invalidate();
	}

	refresh(result: PtcPersistedRenderResult | undefined): void {
		const protocol = this.input.services.getImageProtocol();
		if (!result || !this.input.getView().showImages) {
			this.clear();
			return;
		}
		const nextCache = new Map<string, PtcImageRecord>();
		const nextOrder: PtcImageRecord[] = [];
		for (const block of result.content) {
			const record = this.refreshRecord(block, nextCache, protocol);
			if (!record) continue;
			nextCache.set(record.key, record);
			nextOrder.push(record);
		}
		this.cache = nextCache;
		this.order = nextOrder;
	}

	private refreshRecord(
		block: PtcPersistedRenderResult["content"][number],
		nextCache: ReadonlyMap<string, PtcImageRecord>,
		protocol: ImageProtocol,
	): PtcImageRecord | undefined {
		if (!isImageBlock(block)) return undefined;
		const record = this.getOrCreateRecord(block, nextCache);
		record.generation = this.generation;
		if (requiresPngConversion(record, protocol)) this.startConversion(record);
		return record;
	}

	private getOrCreateRecord(
		block: ImageBlock,
		nextCache: ReadonlyMap<string, PtcImageRecord>,
	): PtcImageRecord {
		const key = imageContentKey(block.data, block.mimeType);
		return (
			nextCache.get(key) ??
			this.cache.get(key) ?? {
				generation: this.generation,
				key,
				source: { data: block.data, mimeType: block.mimeType },
			}
		);
	}

	render(width: number): string[] {
		if (!this.input.getView().showImages) return [];
		const protocol = this.input.services.getImageProtocol();
		const maxWidthCells = Math.max(MINIMUM_IMAGE_WIDTH_CELLS, Math.floor(width));
		const lines: string[] = [];
		for (const record of this.order) {
			const source = record.converted ?? record.source;
			if (protocol === "kitty" && source.mimeType !== IMAGE_PNG_MIME_TYPE) continue;
			if (!record.component || record.componentWidth !== maxWidthCells) {
				record.component = this.input.services.createImage(
					source.data,
					source.mimeType,
					maxWidthCells,
					this.input.getView().theme,
				);
				record.componentWidth = maxWidthCells;
			}
			lines.push(...new Spacer(ROW_SPACING).render(width));
			lines.push(...record.component.render(width));
		}
		return lines;
	}

	private startConversion(record: PtcImageRecord): void {
		let conversion: PtcImageRecord["conversion"];
		try {
			conversion = this.input.services.convertImage(record.source.data, record.source.mimeType);
			record.conversion = conversion;
		} catch (error) {
			this.input.contain(error);
			return;
		}
		void conversion.then(
			(converted) => {
				if (!converted || !this.owns(record)) return;
				record.converted = converted;
				record.component = undefined;
				record.componentWidth = undefined;
				this.input.requestInvalidate();
			},
			(error) => {
				if (!this.owns(record)) return;
				this.input.contain(error);
				this.input.requestInvalidate();
			},
		);
	}

	private owns(record: PtcImageRecord): boolean {
		return (
			this.mounted && record.generation === this.generation && this.cache.get(record.key) === record
		);
	}
}

function isImageBlock(block: PtcPersistedRenderResult["content"][number]): block is ImageBlock {
	return block.type === "image" && Boolean(block.data) && Boolean(block.mimeType);
}

function requiresPngConversion(record: PtcImageRecord, protocol: ImageProtocol): boolean {
	return (
		protocol === "kitty" &&
		record.source.mimeType !== IMAGE_PNG_MIME_TYPE &&
		!record.converted &&
		!record.conversion
	);
}

function imageContentKey(data: string, mimeType: string): string {
	return createHash(IMAGE_HASH_ALGORITHM)
		.update(mimeType)
		.update(IMAGE_KEY_SEPARATOR)
		.update(data)
		.digest("hex");
}
