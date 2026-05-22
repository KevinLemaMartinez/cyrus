/**
 * PlaneIssueTrackerService — minimal POC implementation of an issue tracker
 * service for Plane Community Edition 1.3.1.
 *
 * POC SCOPE (implemented):
 *   - fetchIssue(issueId, projectId)        GET    /workspaces/<slug>/projects/<p>/issues/<i>/
 *   - fetchCurrentUser()                     GET    /users/me/
 *   - createComment(issueId, projectId, body) POST  /workspaces/<slug>/projects/<p>/issues/<i>/comments/
 *   - updateIssue(issueId, projectId, ...)   PATCH  /workspaces/<slug>/projects/<p>/issues/<i>/
 *   - createIssue(projectId, body)           POST   /workspaces/<slug>/projects/<p>/issues/
 *   - getPlatformType / getPlatformMetadata
 *
 * Everything else throws — the edge-worker should not call those paths in
 * the POC flow.
 *
 * Plane CE quirks worth noting:
 *   - Issues are addressed by UUID *and the project_id in the URL*.
 *     There is no workspace-wide /issues/<id>/ shortcut (returns 403).
 *   - `/users/me/` is NOT workspace-scoped — it's at /api/v1/users/me/.
 *   - Auth: `X-API-Key: <plane_api_xxx>` header (per-user API token).
 */
import type {
	PlaneComment,
	PlaneEventTransportConfig,
	PlaneIssueRef,
	PlaneUser,
} from "./types.js";

const NOT_IMPLEMENTED = "Not implemented in POC";

export interface IssueCreateInput {
	name: string;
	description_html?: string;
	priority?: "urgent" | "high" | "medium" | "low" | "none";
	state?: string; // state UUID
	assignees?: string[]; // user UUIDs
	labels?: string[]; // label UUIDs
}

export interface IssueUpdateInput {
	name?: string;
	description_html?: string;
	priority?: "urgent" | "high" | "medium" | "low" | "none";
	state?: string;
	assignees?: string[];
	labels?: string[];
}

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
		const url = `${this.baseUrl}${path}`;
		const res = await fetch(url, {
			method,
			headers: {
				"X-API-Key": this.token,
				"Content-Type": "application/json",
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new PlaneApiError(method, path, res.status, text);
		}
		// PATCH may return empty body on no-op; tolerate.
		const text = await res.text();
		if (text.length === 0) return undefined as unknown as T;
		return JSON.parse(text) as T;
	}

	private wsPath(path: string): string {
		return `/api/v1/workspaces/${this.workspaceSlug}${path}`;
	}

	private projectPath(projectId: string, path: string): string {
		return this.wsPath(`/projects/${projectId}${path}`);
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
		return this.http<PlaneUser>("GET", "/api/v1/users/me/");
	}

	async fetchIssue(issueId: string, projectId: string): Promise<PlaneIssueRef> {
		if (!isUuid(issueId) || !isUuid(projectId)) {
			throw new Error(
				`fetchIssue requires UUIDs (got issueId='${issueId}', projectId='${projectId}')`,
			);
		}
		return this.http<PlaneIssueRef>(
			"GET",
			this.projectPath(projectId, `/issues/${issueId}/`),
		);
	}

	async createIssue(
		projectId: string,
		input: IssueCreateInput,
	): Promise<PlaneIssueRef> {
		return this.http<PlaneIssueRef>(
			"POST",
			this.projectPath(projectId, `/issues/`),
			input,
		);
	}

	async updateIssue(
		issueId: string,
		projectId: string,
		updates: IssueUpdateInput,
	): Promise<PlaneIssueRef> {
		return this.http<PlaneIssueRef>(
			"PATCH",
			this.projectPath(projectId, `/issues/${issueId}/`),
			updates,
		);
	}

	async createComment(
		issueId: string,
		projectId: string,
		commentHtml: string,
	): Promise<PlaneComment> {
		return this.http<PlaneComment>(
			"POST",
			this.projectPath(projectId, `/issues/${issueId}/comments/`),
			{ comment_html: commentHtml },
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

export class PlaneApiError extends Error {
	constructor(
		public readonly method: string,
		public readonly path: string,
		public readonly status: number,
		public readonly body: string,
	) {
		super(
			`Plane API ${method} ${path} -> HTTP ${status} ${body.slice(0, 200)}`,
		);
		this.name = "PlaneApiError";
	}
}

function isUuid(s: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		s,
	);
}
