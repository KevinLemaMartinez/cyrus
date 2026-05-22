/**
 * Plane (Community Edition) webhook payload and entity types.
 *
 * Source of truth: Plane REST API + webhook events as observed in Plane CE 1.3.1.
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
	/** Workspace slug (e.g. "pulpparty") — required to call Plane API. */
	workspaceSlug: string;
	/** Base URL of the Plane instance, e.g. "https://plane.pulp.lan". */
	baseUrl: string;
	/** API token of the bot user that the runner impersonates. */
	apiToken: string;
	/** UUID of the bot user (used to detect "assigned-to-bot" events). */
	botUserId: string;
}

/**
 * Plane sends webhook envelope: { event, action, data } at the top level.
 * `event` identifies the entity type ("issue", "issue_comment", "project", ...).
 * `action` is one of: "created" | "updated" | "deleted".
 */
export interface PlaneWebhookEnvelope<TData = unknown> {
	event: string;
	action: "created" | "updated" | "deleted";
	data: TData;
}

export interface PlaneUser {
	id: string;
	email: string | null;
	first_name: string | null;
	last_name: string | null;
	display_name: string;
	avatar: string | null;
}

export interface PlaneWorkflowState {
	id: string;
	name: string;
	group:
		| "backlog"
		| "unstarted"
		| "started"
		| "completed"
		| "cancelled"
		| "triage";
	color: string;
}

export interface PlaneIssue {
	id: string;
	name: string;
	description_html: string | null;
	description_stripped: string | null;
	priority: "urgent" | "high" | "medium" | "low" | "none";
	state: string; // workflow state id
	project: string; // project id
	workspace: string; // workspace id
	assignees: string[]; // array of user ids
	labels: string[]; // array of label ids
	sequence_id: number; // e.g. PFL-123 → 123
	created_by: string;
	updated_by: string | null;
	created_at: string;
	updated_at: string;
}

export interface PlaneComment {
	id: string;
	issue: string;
	actor: string; // user id
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
	  }
	| {
			type: "comment.created_on_bot_issue";
			issue: PlaneIssue;
			comment: PlaneComment;
			projectId: string;
			workspaceSlug: string;
	  };
