/**
 * Plane (Community Edition) webhook payload and entity types.
 *
 * Shape verified against real payloads from Plane CE 1.3.1 captured on
 * 2026-05-22 (see test/fixtures/*.json).
 *
 * Headers Plane sends on each delivery:
 *   User-Agent:       Autopilot
 *   Content-Type:     application/json
 *   X-Plane-Delivery: <uuid>            unique per delivery; use for dedupe
 *   X-Plane-Event:    issue | issue_comment | ...
 *   X-Plane-Signature: <hex sha256>     HMAC of the raw body keyed with the
 *                                        secret configured in the webhook UI.
 *
 * These types are intentionally narrow — we only model the fields the POC reads.
 */

export type PlaneVerificationMode = "direct" | "proxy";

export interface PlaneEventTransportConfig {
	/** HMAC secret configured in Plane's webhook UI. Required for "direct" mode. */
	secret: string;
	/** "direct" verifies Plane's HMAC signature; "proxy" verifies a Bearer token instead. */
	verificationMode: PlaneVerificationMode;
	/** Optional allowlist of source IPs/CIDRs that may POST to /plane-webhook. */
	ipAllowlist?: string[];
	/** Workspace slug (e.g. "panfleet") — required to call Plane API. */
	workspaceSlug: string;
	/** Base URL of the Plane instance, e.g. "https://plane.pulp.lan". */
	baseUrl: string;
	/** API token of the bot user that the runner impersonates. */
	apiToken: string;
	/** UUID of the bot user (used to detect "assigned-to-bot" events). */
	botUserId: string;
}

/**
 * Top-level envelope of every Plane webhook delivery.
 */
export interface PlaneWebhookEnvelope<TData = unknown> {
	event: string;
	action: "created" | "updated" | "deleted";
	webhook_id: string;
	workspace_id: string;
	data: TData;
	activity?: PlaneActivity;
}

/**
 * Activity record attached to update/create events. Carries the diff
 * (`field`, `new_value`, `old_value`) and the user who triggered the change.
 */
export interface PlaneActivity {
	field: string | null;
	new_value: unknown;
	old_value: unknown;
	actor: PlaneUser;
	old_identifier: string | null;
	new_identifier: string | null;
}

export interface PlaneUser {
	id: string;
	email: string;
	first_name: string;
	last_name: string;
	display_name: string;
	avatar: string;
	avatar_url: string | null;
}

export interface PlaneState {
	id: string;
	name: string;
	color: string;
	group:
		| "backlog"
		| "unstarted"
		| "started"
		| "completed"
		| "cancelled"
		| "triage";
}

/**
 * Plane returns two different shapes for the same issue depending on where
 * you read it from:
 *
 *   - Webhook payloads ({@link PlaneIssue}): nested objects in `state` and
 *     `assignees`. Plane "expands" foreign keys for the consumer.
 *   - REST API ({@link PlaneIssueRef}): only the UUIDs are returned in
 *     `state` and `assignees`. The consumer has to fetch related entities
 *     separately if it needs the name / group / email.
 *
 * The POC modeling acknowledges both shapes explicitly instead of trying
 * to merge them into a single union.
 */
interface PlaneIssueBase {
	id: string;
	name: string;
	description_html: string | null;
	description_stripped?: string | null;
	priority: "urgent" | "high" | "medium" | "low" | "none";
	project: string;
	workspace: string;
	labels: string[];
	sequence_id: number;
	created_by: string | null;
	updated_by: string | null;
	created_at: string;
	updated_at: string;
	deleted_at: string | null;
	is_draft: boolean;
	parent: string | null;
	target_date: string | null;
	start_date: string | null;
	completed_at: string | null;
	archived_at: string | null;
}

/**
 * Issue as delivered inside a Plane webhook payload — `state` and
 * `assignees` come expanded as full objects.
 */
export interface PlaneIssue extends PlaneIssueBase {
	state: PlaneState;
	assignees: PlaneUser[];
}

/**
 * Issue as returned by the REST API (`GET /workspaces/<slug>/projects/<p>/issues/<i>/`)
 * — `state` is the state UUID, `assignees` is an array of user UUIDs.
 */
export interface PlaneIssueRef extends PlaneIssueBase {
	state: string;
	assignees: string[];
}

export interface PlaneComment {
	id: string;
	issue: string;
	actor: string;
	comment_html: string;
	comment_stripped: string;
	created_at: string;
	updated_at: string;
}

/** Top-level events emitted by the transport. */
export interface PlaneEventTransportEvents {
	/** A normalized agent event (assignment to bot, comment mention, etc.). */
	event: (payload: PlaneAgentEvent) => void;
	error: (err: Error) => void;
}

/**
 * Canonical event the edge-worker consumes. We intentionally keep this shape
 * close to Linear's AgentEvent so the worker dispatch logic doesn't branch.
 */
export type PlaneAgentEvent =
	| {
			type: "issue.assigned_to_bot";
			issue: PlaneIssue;
			projectId: string;
			workspaceSlug: string;
			actor: PlaneUser;
	  }
	| {
			type: "comment.created_on_bot_issue";
			issue: PlaneIssue;
			comment: PlaneComment;
			projectId: string;
			workspaceSlug: string;
			actor: PlaneUser;
	  };
