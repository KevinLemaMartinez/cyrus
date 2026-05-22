/**
 * Helpers for parsing and verifying Plane CE webhook payloads.
 *
 * Plane's webhook contract (CE 1.3.1):
 *   - Body: JSON envelope { event, action, data }
 *   - Header `x-plane-signature`: HMAC-SHA256 hex digest of the raw body
 *     keyed with the secret configured in the webhook UI.
 *
 * NOTE: header naming is observed empirically and may evolve; keep a TODO to
 * confirm against `makeplane/plane` source once the POC is wired.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type {
	PlaneAgentEvent,
	PlaneComment,
	PlaneIssue,
	PlaneWebhookEnvelope,
} from "./types.js";

export function verifyPlaneSignature(
	rawBody: string,
	signatureHeader: string | undefined,
	secret: string,
): boolean {
	if (!signatureHeader) return false;
	const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
	const provided = signatureHeader.trim();
	if (expected.length !== provided.length) return false;
	return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

export function isIssueEnvelope(
	env: PlaneWebhookEnvelope,
): env is PlaneWebhookEnvelope<PlaneIssue> {
	return (
		env.event === "issue" && typeof env.data === "object" && env.data !== null
	);
}

export function isCommentEnvelope(
	env: PlaneWebhookEnvelope,
): env is PlaneWebhookEnvelope<PlaneComment> {
	return (
		env.event === "issue_comment" &&
		typeof env.data === "object" &&
		env.data !== null
	);
}

/**
 * True iff the bot user appears in `issue.assignees`.
 * The transport receives only the new state — for "newly assigned" detection
 * we rely on Plane's `action === "updated"` plus a dedupe key upstream
 * (BullMQ SETNX in edge-worker).
 */
export function isAssignedToBot(issue: PlaneIssue, botUserId: string): boolean {
	return issue.assignees.includes(botUserId);
}

/**
 * Translate a verified Plane envelope into the canonical PlaneAgentEvent
 * the edge-worker consumes. Returns `null` if the envelope is not actionable
 * (e.g. an issue update that does not involve the bot).
 */
export function translatePayload(
	env: PlaneWebhookEnvelope,
	ctx: { botUserId: string; workspaceSlug: string },
): PlaneAgentEvent | null {
	if (isIssueEnvelope(env)) {
		const issue = env.data;
		if (!isAssignedToBot(issue, ctx.botUserId)) return null;
		return {
			type: "issue.assigned_to_bot",
			issue,
			projectId: issue.project,
			workspaceSlug: ctx.workspaceSlug,
		};
	}
	if (isCommentEnvelope(env)) {
		// TODO POC+1: only emit if parent issue has bot in assignees.
		// For POC scope we drop comment events entirely (no multi-turn).
		return null;
	}
	return null;
}
