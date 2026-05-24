/**
 * Helpers for parsing and verifying Plane CE webhook payloads.
 *
 * Plane's webhook contract (CE 1.3.1, verified against captured fixtures):
 *   - Body: JSON envelope `{ event, action, webhook_id, workspace_id, data, activity? }`
 *   - Header `X-Plane-Signature`: HMAC-SHA256 hex digest of the raw body
 *     keyed with the secret configured in the webhook UI.
 *   - Header `X-Plane-Event`: event type (mirrors `body.event`).
 *   - Header `X-Plane-Delivery`: UUID, unique per delivery — use for dedupe.
 *   - Header `User-Agent`: "Autopilot".
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type {
	PlaneActivity,
	PlaneAgentEvent,
	PlaneComment,
	PlaneIssue,
	PlaneUser,
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
 * True iff the issue currently lists the bot among its assignees.
 * Useful for create events where there is no diff in `activity`.
 */
export function isAssignedToBot(issue: PlaneIssue, botUserId: string): boolean {
	return Array.isArray(issue.assignees)
		? issue.assignees.some((a) => a.id === botUserId)
		: false;
}

/**
 * True iff the activity diff represents *the moment the bot was added* to the
 * assignees (was not there before, is there now). This is the cleanest trigger
 * because it ignores re-saves, label changes, comment edits, etc.
 */
export function wasJustAssignedToBot(
	activity: PlaneActivity | undefined,
	botUserId: string,
): boolean {
	if (!activity) return false;
	if (activity.field !== "assignee_ids") return false;
	const newIds = Array.isArray(activity.new_value)
		? (activity.new_value as unknown[]).filter(
				(v): v is string => typeof v === "string",
			)
		: [];
	const oldIds = Array.isArray(activity.old_value)
		? (activity.old_value as unknown[]).filter(
				(v): v is string => typeof v === "string",
			)
		: [];
	return newIds.includes(botUserId) && !oldIds.includes(botUserId);
}

/**
 * Translate a verified Plane envelope into the canonical PlaneAgentEvent
 * the edge-worker consumes. Returns `null` if the envelope is not actionable
 * (e.g. an issue update that does not involve the bot).
 *
 * Trigger rules for the POC:
 *   - `issue.created` with bot in assignees     -> emit
 *   - `issue.updated` with activity diff adding the bot  -> emit
 *   - Anything else                              -> drop
 */
export function translatePayload(
	env: PlaneWebhookEnvelope,
	ctx: { botUserIds: string[]; workspaceSlug: string },
): PlaneAgentEvent | null {
	if (isIssueEnvelope(env)) {
		const issue = env.data;
		const isCreatedWithBot =
			env.action === "created" &&
			ctx.botUserIds.some((id) => isAssignedToBot(issue, id));
		const isJustAssigned =
			env.action === "updated" &&
			ctx.botUserIds.some((id) => wasJustAssignedToBot(env.activity, id));
		if (!isCreatedWithBot && !isJustAssigned) return null;
		return {
			type: "issue.assigned_to_bot",
			issue,
			projectId: issue.project,
			workspaceSlug: ctx.workspaceSlug,
			actor: env.activity?.actor ?? syntheticActor(issue.created_by),
		};
	}
	if (isCommentEnvelope(env)) {
		if (env.action !== "created") return null;
		const comment = env.data;
		// Anti-loop: ignore comments authored by any configured bot.
		if (comment.actor && ctx.botUserIds.includes(comment.actor)) return null;
		// The "bot is assigned to the parent issue" check is intentionally
		// deferred to handlePlaneEvent — the webhook does not expand the
		// issue, so we'd need a REST fetch here. We don't want the translator
		// to do I/O.
		return {
			type: "comment.created_on_bot_issue",
			issueId: comment.issue,
			comment,
			// Plane's comment webhook does not include a projectId in the
			// envelope. Consumers must resolve project via fetchIssue when
			// they need it.
			projectId: "",
			workspaceSlug: ctx.workspaceSlug,
			actor: syntheticActor(comment.actor),
		};
	}
	return null;
}

function syntheticActor(userId: string | null): PlaneUser {
	return {
		id: userId ?? "00000000-0000-0000-0000-000000000000",
		email: "",
		first_name: "",
		last_name: "",
		display_name: "",
		avatar: "",
		avatar_url: null,
	};
}
