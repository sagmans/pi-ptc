// Session-owned artifact storage. Copies survive worker termination and
// source deletion; automatic spill writes only successful final results.

import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { copyFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";

import type { JsonValue } from "./json.ts";

export const ARTIFACT_KIND = "ptc-artifact" as const;
export const DEFAULT_ARTIFACT_MIME_TYPE = "application/octet-stream";
export const RESULT_ARTIFACT_NAME = "result.json";
export const RESULT_ARTIFACT_MIME_TYPE = "application/json";
const ARTIFACT_DIRECTORY_SUFFIX = ".artifacts";
const NUL = "\0";

export type ArtifactInput = {
	path: string;
	name?: string;
	mimeType?: string;
};

export type PtcArtifactRef = {
	kind: typeof ARTIFACT_KIND;
	id: string;
	name: string;
	mimeType: string;
	bytes: number;
	path: string;
};

export type ArtifactSessionManager = {
	getSessionFile(): string | undefined;
	getSessionId(): string;
};

export type ArtifactRuntime = {
	readonly cwd: string;
	readonly directory: string;
};

export function isArtifactRef(value: JsonValue): value is PtcArtifactRef {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		value.kind === ARTIFACT_KIND &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.mimeType === "string" &&
		typeof value.bytes === "number" &&
		typeof value.path === "string"
	);
}

export function resolveArtifactRuntime(ctx: {
	cwd: string;
	sessionManager?: ArtifactSessionManager;
}): ArtifactRuntime | undefined {
	const manager = ctx.sessionManager;
	if (!manager) return undefined;
	// Persistent sessions keep artifacts beside the session file; ephemeral
	// sessions fall back to process temporary storage.
	const sessionFile = manager.getSessionFile();
	if (typeof sessionFile === "string" && sessionFile.length > 0) {
		return { cwd: ctx.cwd, directory: sessionFile + ARTIFACT_DIRECTORY_SUFFIX };
	}
	return {
		cwd: ctx.cwd,
		directory: join(tmpdir(), `pi-ptc-${manager.getSessionId()}${ARTIFACT_DIRECTORY_SUFFIX}`),
	};
}

function assertSafeArtifactName(name: string): void {
	if (
		name.length === 0 ||
		name === "." ||
		name === ".." ||
		name.includes("/") ||
		name.includes("\\") ||
		name.includes(NUL)
	) {
		throw new Error(
			`artifact name must be a non-empty file name without separators: ${JSON.stringify(name)}`,
		);
	}
}

function sanitizedExtension(name: string): string {
	const extension = extname(name);
	return /^[.][A-Za-z0-9._-]*$/.test(extension) ? extension : "";
}

async function persistDestination(
	runtime: ArtifactRuntime,
	contents: Uint8Array,
	extension: string,
): Promise<string> {
	await mkdir(runtime.directory, { recursive: true });
	// ponytail: rename-based atomicity per file; no cross-platform fsync of the
	// directory, durable-enough for session-owned model output.
	const destination = join(runtime.directory, randomUUID() + extension);
	const temporary = `${destination}.${randomUUID()}.tmp`;
	await writeFile(temporary, contents);
	await rename(temporary, destination);
	return destination;
}

async function captureArtifact(
	runtime: ArtifactRuntime,
	input: ArtifactInput,
): Promise<PtcArtifactRef> {
	const name = input.name ?? basename(input.path);
	assertSafeArtifactName(name);
	const mimeType = input.mimeType ?? DEFAULT_ARTIFACT_MIME_TYPE;
	const source = isAbsolute(input.path) ? input.path : resolve(runtime.cwd, input.path);
	let sourceStat: Stats;
	try {
		sourceStat = await stat(source);
	} catch {
		throw new Error(`artifact source must be an existing regular file: ${source}`);
	}
	if (!sourceStat.isFile()) {
		throw new Error(`artifact source must be an existing regular file: ${source}`);
	}
	await mkdir(runtime.directory, { recursive: true });
	const destination = join(runtime.directory, randomUUID() + sanitizedExtension(name));
	const temporary = `${destination}.${randomUUID()}.tmp`;
	await copyFile(source, temporary);
	await rename(temporary, destination);
	const bytes = (await stat(destination)).size;
	return { kind: ARTIFACT_KIND, id: randomUUID(), name, mimeType, bytes, path: destination };
}

export function createArtifactFunction(
	runtime: ArtifactRuntime | undefined,
): (input: ArtifactInput) => Promise<PtcArtifactRef> {
	return async (input) => {
		if (!runtime) {
			throw new Error(
				"artifact storage is unavailable for this session; return a smaller projection instead",
			);
		}
		return captureArtifact(runtime, input);
	};
}

export async function writeResultArtifact(
	runtime: ArtifactRuntime,
	value: JsonValue,
): Promise<PtcArtifactRef> {
	const serialized = JSON.stringify(value);
	const destination = await persistDestination(runtime, Buffer.from(serialized, "utf8"), ".json");
	return {
		kind: ARTIFACT_KIND,
		id: randomUUID(),
		name: RESULT_ARTIFACT_NAME,
		mimeType: RESULT_ARTIFACT_MIME_TYPE,
		bytes: Buffer.byteLength(serialized, "utf8"),
		path: destination,
	};
}
