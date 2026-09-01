import type { ExtensionAPI } from "./src/host.ts";
import { bootstrapPtcPackage } from "./src/package-bootstrap.ts";

export default async function installPtcPackage(pi: ExtensionAPI): Promise<void> {
	await bootstrapPtcPackage(pi);
}
