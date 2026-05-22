/**
 * PlaneIssueTrackerService — minimal POC implementation of an issue tracker
 * service for Plane Community Edition 1.3.1.
 *
 * POC SCOPE (implemented):
 *   - fetchIssue
 *   - fetchCurrentUser
 *   - createComment
 *   - updateIssue (limited: state + assignees only)
 *   - getPlatformType / getPlatformMetadata
 *
 * Everything else throws — the edge-worker should not call those paths in
 * the POC flow. When we move beyond POC, fill these in following the same
 * pattern (REST call against /api/v1/workspaces/:slug/projects/:project/...).
 *
 * Plane API auth: Bearer token from a per-bot API key. Token is held in
 * `config.apiToken` and never logged.
 */
import type {
	PlaneComment,
	PlaneEventTransportConfig,
	PlaneIssue,
	PlaneUser,
} from "./types.js";

const NOT_IMPLEMENTED = "Not implemented in POC";

export class PlaneIssueTrackerService {
	private readonly baseUrl: string;
	private readonly workspaceSlug: string;
	private readonly token: string;

	constructor(config: PlaneEventTransportConfig) {
		this.baseUrl = config.baseUrl.replace(/\/$/, "");
		this.workspaceSlug = config.workspaceSlug;
		this.token = config.apiToken;
	}

	private async http<T>(
		method: "GET" | "POST" | "PATCH" | "DELETE",
		path: string,
		body?: unknown,
	): Promise<T> {
		const url = `${this.baseUrl}/api/v1/workspaces/${this.workspaceSlug}${path}`;
		const res = await fetch(url, {
			method,
			headers: {
				"X-API-Key": this.token,
				"Content-Type": "application/json",
			},
			body: body ? JSON.stringify(body) : undefined,
		});
		if (!res.ok) {
			throw new Error(
				`Plane API ${method} ${path} -> ${res.status} ${await res.text()}`,
			);
		}
		return (await res.json()) as T;
	}

	// ──────────────────────────────────────────────────────────────────────
	// Implemented in POC
	// ──────────────────────────────────────────────────────────────────────

	getPlatformType(): string {
		return "plane";
	}

	getPlatformMetadata(): Record<string, unknown> {
		return {
			baseUrl: this.baseUrl,
			workspace: this.workspaceSlug,
			edition: "community",
		};
	}

	async fetchCurrentUser(): Promise<PlaneUser> {
		// Plane has a workspace-scoped "me" endpoint
		return this.http<PlaneUser>("GET", `/users/me/`);
	}

	async fetchIssue(idOrIdentifier: string): Promise<PlaneIssue> {
		// In Plane CE, issues are addressed by UUID; sequence identifiers
		// (PFL-123) are project-scoped and require a separate lookup.
		// POC accepts only UUIDs.
		if (!isUuid(idOrIdentifier)) {
			throw new Error(
				`POC accepts only UUIDs for fetchIssue; got '${idOrIdentifier}'`,
			);
		}
		// Plane requires project_id in the path — caller must pass it via
		// PlaneAgentEvent.projectId. fetchIssue here is by UUID, so we use
		// the workspace-level issue endpoint:
		return this.http<PlaneIssue>("GET", `/issues/${idOrIdentifier}/`);
	}

	async createComment(
		issueId: string,
		projectId: string,
		body: string,
	): Promise<PlaneComment> {
		return this.http<PlaneComment>(
			"POST",
			`/projects/${projectId}/issues/${issueId}/comments/`,
			{ comment_html: body },
		);
	}

	async updateIssue(
		issueId: string,
		projectId: string,
		updates: { state?: string; assignees?: string[] },
	): Promise<PlaneIssue> {
		return this.http<PlaneIssue>(
			"PATCH",
			`/projects/${projectId}/issues/${issueId}/`,
			updates,
		);
	}

	// ──────────────────────────────────────────────────────────────────────
	// Stubs (post-POC)
	// ──────────────────────────────────────────────────────────────────────

	fetchIssueChildren(): never {
		throw new Error(NOT_IMPLEMENTED);
	}
	fetchIssueAttachments(): never {
		throw new Error(NOT_IMPLEMENTED);
	}
	fetchComments(): never {
		throw new Error(NOT_IMPLEMENTED);
	}
	fetchComment(): never {
		throw new Error(NOT_IMPLEMENTED);
	}
	fetchCommentWithAttachments(): never {
		throw new Error(NOT_IMPLEMENTED);
	}
	fetchTeams(): never {
		throw new Error(NOT_IMPLEMENTED);
	}
	fetchTeam(): never {
		throw new Error(NOT_IMPLEMENTED);
	}
	fetchLabels(): never {
		throw new Error(NOT_IMPLEMENTED);
	}
	fetchLabel(): never {
		throw new Error(NOT_IMPLEMENTED);
	}
	getIssueLabels(): never {
		throw new Error(NOT_IMPLEMENTED);
	}
	fetchWorkflowStates(): never {
		throw new Error(NOT_IMPLEMENTED);
	}
	fetchWorkflowState(): never {
		throw new Error(NOT_IMPLEMENTED);
	}
	fetchUser(): never {
		throw new Error(NOT_IMPLEMENTED);
	}
	createAgentSessionOnIssue(): never {
		throw new Error(NOT_IMPLEMENTED);
	}
	createAgentSessionOnComment(): never {
		throw new Error(NOT_IMPLEMENTED);
	}
	fetchAgentSession(): never {
		throw new Error(NOT_IMPLEMENTED);
	}
	emitStopSignalEvent(): never {
		throw new Error(NOT_IMPLEMENTED);
	}
	createAgentActivity(): never {
		throw new Error(NOT_IMPLEMENTED);
	}
	requestFileUpload(): never {
		throw new Error(NOT_IMPLEMENTED);
	}
}

function isUuid(s: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		s,
	);
}
