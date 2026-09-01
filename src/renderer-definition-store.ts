// One model-visible tool. Intermediate binding values stay off the transcript.

import type { PtcDefinitionRegistry } from "./renderer.ts";

// Downstream result middleware can delay first render, so retain a small FIFO of call tokens.
export const MAX_PENDING_RENDER_SNAPSHOTS = 128;

export const MAX_RENDERER_CALL_ID_HISTORY = 128;

export type RendererToken = {
	readonly toolCallId: string;
	readonly epoch: number;
	readonly bareCallIdFallback: boolean;
	state: "pending" | "claimed" | "revoked";
	definitions?: PtcDefinitionRegistry;
};

export type PendingRendererSlot =
	| { readonly kind: "token"; readonly token: RendererToken }
	| { readonly kind: "ambiguous" };

export type RendererTokens = {
	begin(toolCallId: string): RendererToken;
	provide(token: RendererToken, definitions: PtcDefinitionRegistry | undefined): void;
	attach(details: object, token: RendererToken): void;
	claim(details: unknown, toolCallId: string): PtcDefinitionRegistry | undefined;
	revoke(token: RendererToken): void;
	clear(): void;
};

export function createRendererTokens(
	pendingLimit: number,
	callIdHistoryLimit: number,
): RendererTokens {
	if (!Number.isSafeInteger(pendingLimit) || pendingLimit < 1) {
		throw new RangeError("Pending renderer snapshot limit must be a positive safe integer");
	}
	if (!Number.isSafeInteger(callIdHistoryLimit) || callIdHistoryLimit < 1) {
		throw new RangeError("Renderer call-ID history limit must be a positive safe integer");
	}
	let lifecycleEpoch = 0;
	let bareCallIdFallbackEnabled = true;
	const callIdHistory = new Set<string>();
	const pending = new Map<string, PendingRendererSlot>();
	const attachments = new WeakMap<object, RendererToken>();
	const isPending = (token: RendererToken): boolean =>
		token.state === "pending" && token.epoch === lifecycleEpoch;
	const reserveBareCallIdFallback = (toolCallId: string): boolean => {
		if (!bareCallIdFallbackEnabled || callIdHistory.has(toolCallId)) return false;
		// Never evict one ID: forgetting it could authorize a stale clone after reuse.
		if (callIdHistory.size >= callIdHistoryLimit) {
			bareCallIdFallbackEnabled = false;
			callIdHistory.clear();
			return false;
		}
		callIdHistory.add(toolCallId);
		return true;
	};
	const removePendingToken = (token: RendererToken): void => {
		const slot = pending.get(token.toolCallId);
		if (slot?.kind === "token" && slot.token === token) pending.delete(token.toolCallId);
	};
	const revoke = (token: RendererToken): void => {
		if (token.state === "revoked") return;
		token.state = "revoked";
		token.definitions = undefined;
		removePendingToken(token);
	};
	const enforceLimit = (): void => {
		while (pending.size > pendingLimit) {
			const oldestCallId = pending.keys().next().value;
			if (oldestCallId === undefined) break;
			const oldest = pending.get(oldestCallId);
			if (oldest?.kind === "token") revoke(oldest.token);
			pending.delete(oldestCallId);
		}
	};
	const claimToken = (
		token: RendererToken,
		toolCallId: string,
	): PtcDefinitionRegistry | undefined => {
		if (!isPending(token) || token.toolCallId !== toolCallId || !token.definitions) {
			return undefined;
		}
		const definitions = token.definitions;
		token.state = "claimed";
		token.definitions = undefined;
		removePendingToken(token);
		return definitions;
	};
	return {
		begin(toolCallId) {
			const token: RendererToken = {
				toolCallId,
				epoch: lifecycleEpoch,
				bareCallIdFallback: reserveBareCallIdFallback(toolCallId),
				state: "pending",
			};
			const existing = pending.get(toolCallId);
			if (existing) {
				if (existing.kind === "token") revoke(existing.token);
				revoke(token);
				pending.delete(toolCallId);
				pending.set(toolCallId, { kind: "ambiguous" });
			} else {
				pending.set(toolCallId, { kind: "token", token });
			}
			enforceLimit();
			return token;
		},
		provide(token, definitions) {
			if (!isPending(token)) return;
			if (!definitions) {
				revoke(token);
				return;
			}
			token.definitions = definitions;
		},
		attach(details, token) {
			attachments.set(details, token);
		},
		claim(details, toolCallId) {
			if (typeof details === "object" && details !== null) {
				const attached = attachments.get(details);
				if (attached) return claimToken(attached, toolCallId);
			}
			if (!bareCallIdFallbackEnabled) return undefined;
			const slot = pending.get(toolCallId);
			return slot?.kind === "token" && slot.token.bareCallIdFallback
				? claimToken(slot.token, toolCallId)
				: undefined;
		},
		revoke,
		clear() {
			lifecycleEpoch += 1;
			// Serialized details carry no lifecycle generation, so bare lookup cannot resume safely.
			bareCallIdFallbackEnabled = false;
			callIdHistory.clear();
			for (const slot of pending.values()) {
				if (slot.kind === "token") revoke(slot.token);
			}
			pending.clear();
		},
	};
}
