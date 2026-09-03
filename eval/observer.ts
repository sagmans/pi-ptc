// Evaluation observer extension: decoy catalog pressure and provider-request
// byte counting. Loaded in every evaluation condition.

import { Type } from "typebox";

const DEFAULT_DECOY_COUNT = 24;
const PROVIDER_BYTES_ENTRY_TYPE = "eval-provider-request-bytes";
const DECOY_DESCRIPTION = "Deterministic irrelevant evaluation decoy tool";

const decoyCount = Number.parseInt(process.env.PI_PTC_EVAL_DECOYS ?? "", 10);

export default function installEvaluationObserver(pi: {
	registerTool(definition: object): void;
	appendEntry(customType: string, data?: unknown): void;
	on(event: string, handler: (...args: unknown[]) => unknown): void;
}): void {
	for (
		let index = 0;
		index < (Number.isFinite(decoyCount) ? decoyCount : DEFAULT_DECOY_COUNT);
		index += 1
	) {
		pi.registerTool({
			name: `eval_decoy_${index}`,
			label: `Eval decoy ${index}`,
			description: `${DECOY_DESCRIPTION} #${index}`,
			parameters: Type.Object({ value: Type.Optional(Type.String()) }),
			async execute() {
				return { content: [{ type: "text", text: "decoy" }] };
			},
		});
	}
	pi.on("before_provider_request", (payload) => {
		// Record only the serialized payload size; never persist provider
		// payload content, headers, credentials, or environment values.
		pi.appendEntry(PROVIDER_BYTES_ENTRY_TYPE, {
			bytes: Buffer.byteLength(JSON.stringify(payload ?? null), "utf8"),
		});
		return undefined;
	});
}
