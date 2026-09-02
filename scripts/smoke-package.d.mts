export function validateTarballPath(tarballPath: string): string;
export function parseTarballArgument(args: string[]): string | undefined;
export function smokePackage(tarballPath?: string, rootDirectory?: string): Promise<string>;
