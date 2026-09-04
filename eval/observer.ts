// Evaluation observer extension: provider-request byte counting.
// Loaded in every evaluation condition.

const PROVIDER_BYTES_ENTRY_TYPE = "eval-provider-request-bytes";

export default function installEvaluationObserver(pi: {
	appendEntry(customType: string, data?: unknown): void;
	on(event: string, handler: (...args: unknown[]) => unknown): void;
}): void {
	pi.on("before_provider_request", (payload) => {
		// Record only the serialized payload size; never persist provider
		// payload content, headers, credentials, or environment values.
		pi.appendEntry(PROVIDER_BYTES_ENTRY_TYPE, {
			bytes: Buffer.byteLength(JSON.stringify(payload ?? null), "utf8"),
		});
		return undefined;
	});
}
