import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "./host.ts";
import { isSupportedPiVersion } from "./pi-runtime-version.ts";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PACKAGE_FILE_NAME = "package.json";
const MAX_PACKAGE_PARENT_DEPTH = 8;

type Installer = (pi: ExtensionAPI) => void;

export type PackageBootstrapOptions = {
	resolveVersion?(): string | undefined;
	loadInstaller?(): Promise<Installer>;
};

function readPiVersionFromPackage(): string | undefined {
	let directory = dirname(fileURLToPath(import.meta.resolve(PI_PACKAGE_NAME)));
	for (let depth = 0; depth < MAX_PACKAGE_PARENT_DEPTH; depth += 1) {
		try {
			const value = JSON.parse(readFileSync(join(directory, PACKAGE_FILE_NAME), "utf8")) as {
				name?: unknown;
				version?: unknown;
			};
			if (value.name === PI_PACKAGE_NAME) {
				return typeof value.version === "string" ? value.version : undefined;
			}
		} catch {}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return undefined;
}

async function loadPtcInstaller(): Promise<Installer> {
	const module = await import("./index.ts");
	return module.default;
}

export async function bootstrapPtcPackage(
	pi: ExtensionAPI,
	options: PackageBootstrapOptions = {},
): Promise<boolean> {
	const version = (options.resolveVersion ?? readPiVersionFromPackage)();
	if (version === undefined || !isSupportedPiVersion(version)) return false;
	const installer = await (options.loadInstaller ?? loadPtcInstaller)();
	installer(pi);
	return true;
}
