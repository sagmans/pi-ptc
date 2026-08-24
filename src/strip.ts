// Pi's shipped binary is Bun. Node's type-strip API does not exist there.

import nodeModule from "node:module";

import { STRIP_UNAVAILABLE_MESSAGE, TYPESCRIPT_LOADER } from "./config.ts";

export type StripFn = (source: string) => string;

type BunTranspiler = {
	transformSync(source: string): string;
};

export type BunTranspilerCtor = new (options: { loader: string }) => BunTranspiler;

export type StripHosts = {
	nodeStrip?: unknown;
	bunTranspiler?: BunTranspilerCtor;
};

function asStripFn(value: unknown): StripFn | undefined {
	return typeof value === "function" ? (value as StripFn) : undefined;
}

export function resolveStripFn(hosts: StripHosts): StripFn {
	const nodeStrip = asStripFn(hosts.nodeStrip);
	if (nodeStrip) return nodeStrip;
	if (hosts.bunTranspiler) {
		const transpiler = new hosts.bunTranspiler({ loader: TYPESCRIPT_LOADER });
		return (source) => transpiler.transformSync(source);
	}
	throw new Error(STRIP_UNAVAILABLE_MESSAGE);
}

function runtimeHosts(): StripHosts {
	const bun = (globalThis as { Bun?: { Transpiler?: BunTranspilerCtor } }).Bun;
	return {
		nodeStrip: (nodeModule as { stripTypeScriptTypes?: unknown }).stripTypeScriptTypes,
		bunTranspiler: bun?.Transpiler,
	};
}

export function stripProgram(source: string): string {
	return resolveStripFn(runtimeHosts())(source);
}
