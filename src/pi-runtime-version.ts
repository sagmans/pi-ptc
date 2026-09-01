export const MINIMUM_SUPPORTED_PI_VERSION = "0.84.3";
export const SUPPORTED_PI_VERSION = "0.84.4";
export const UNSUPPORTED_PI_VERSION_DIAGNOSTIC = "Unsupported Pi runtime version";
export const SUPPORTED_PI_VERSIONS = Object.freeze([
	MINIMUM_SUPPORTED_PI_VERSION,
	SUPPORTED_PI_VERSION,
] as const);

export type SupportedPiVersion = (typeof SUPPORTED_PI_VERSIONS)[number];

export function isSupportedPiVersion(version: string): version is SupportedPiVersion {
	return (SUPPORTED_PI_VERSIONS as readonly string[]).includes(version);
}

export function getPiRuntimeVersionDiagnostic(
	importedVersion: string,
	suppliedVersion?: string,
): string | undefined {
	if (!isSupportedPiVersion(importedVersion)) {
		return `${UNSUPPORTED_PI_VERSION_DIAGNOSTIC}: expected one of ${SUPPORTED_PI_VERSIONS.join(", ")}, imported ${importedVersion}`;
	}
	if (suppliedVersion !== undefined && suppliedVersion !== importedVersion) {
		return `${UNSUPPORTED_PI_VERSION_DIAGNOSTIC}: imported ${importedVersion}, supplied ${suppliedVersion}`;
	}
	return undefined;
}
