/**
 * PlaneSessionRunner — orchestrates the Plane CE pipeline for an assignment
 * and follow-up comments.
 *
 * Assignment flow:
 *   1. Post an acknowledge comment on the Plane issue.
 *   2. Build a MinimalIssue shim that the existing GitService can consume.
 *   3. Create a git worktree for the issue.
 *   4. Spawn a ClaudeRunner via startStreaming so subsequent comments can
 *      addStreamMessage while it is still running.
 *   5. On complete, persist the resulting Claude session id in
 *      PlaneSessionStore so dead-runner comments can resume.
 *
 * Comment flow (handleComment):
 *   - Live runner → addStreamMessage.
 *   - Dead runner with stored claudeSessionId → spawn a new runner with
 *     resumeSessionId set, startStreaming(commentText).
 *   - No prior session → post "reassign to start" and drop.
 *
 * Dependencies are injected so the runner can be unit-tested without a real
 * ClaudeRunner / GitService / Plane API.
 */
import type { EventEmitter } from "node:events";
import type { ClaudeRunnerConfig, SDKMessage } from "cyrus-claude-runner";
import {
	createLogger,
	type ILogger,
	type Issue,
	type RepositoryConfig,
	type Workspace,
} from "cyrus-core";
import type {
	PlaneAgentEvent,
	PlaneIssue,
	PlaneIssueRef,
	PlaneIssueTrackerService,
} from "cyrus-plane-event-transport";
import type { GitService } from "./GitService.js";
import { PlaneClaudeActivityPoster } from "./PlaneClaudeActivityPoster.js";
import type { PlaneSessionStore } from "./PlaneSessionStore.js";
import { escapeHtml } from "./plane-html-utils.js";

const DEFAULT_MAX_TURNS = 40;

export type ClaudeRunnerHandle = EventEmitter & {
	start: (prompt: string) => Promise<unknown>;
	startStreaming: (initialPrompt?: string) => Promise<unknown>;
	addStreamMessage?: (content: string) => void;
	completeStream?: () => void;
	stop?: () => void | Promise<void>;
	isRunning?: () => boolean;
	supportsStreamingInput?: boolean;
	getSessionInfo?: () => { sessionId: string | null } | null;
};

export type ClaudeRunnerFactory = (
	config: ClaudeRunnerConfig,
) => ClaudeRunnerHandle;

export interface PlaneSessionRunnerConfig {
	gitService: GitService;
	planeIssueTracker: PlaneIssueTrackerService;
	claudeRunnerFactory: ClaudeRunnerFactory;
	sessionStore: PlaneSessionStore;
	cyrusHome: string;
	logger?: ILogger;
}

export class PlaneSessionRunner {
	private readonly gitService: GitService;
	private readonly planeIssueTracker: PlaneIssueTrackerService;
	private readonly claudeRunnerFactory: ClaudeRunnerFactory;
	private readonly sessionStore: PlaneSessionStore;
	private readonly cyrusHome: string;
	private readonly logger: ILogger;
	private readonly active: Map<string, ClaudeRunnerHandle> = new Map();

	constructor(config: PlaneSessionRunnerConfig) {
		this.gitService = config.gitService;
		this.planeIssueTracker = config.planeIssueTracker;
		this.claudeRunnerFactory = config.claudeRunnerFactory;
		this.sessionStore = config.sessionStore;
		this.cyrusHome = config.cyrusHome;
		this.logger =
			config.logger ?? createLogger({ component: "PlaneSessionRunner" });
	}

	async handleAssignment(
		event: Extract<PlaneAgentEvent, { type: "issue.assigned_to_bot" }>,
		repo: RepositoryConfig,
	): Promise<void> {
		const issueId = event.issue.id;
		const projectId = event.projectId;

		this.logger.info(
			`Handling Plane assignment for issue ${issueId} → repo '${repo.id}'`,
		);

		// 1. Acknowledge.
		try {
			await this.planeIssueTracker.createComment(
				issueId,
				projectId,
				"<p>👋 He recibido la asignación, arrancando…</p>",
			);
		} catch (err) {
			this.logger.error(
				`Acknowledge comment failed for ${issueId}: ${err instanceof Error ? err.message : String(err)}`,
			);
			return;
		}

		// 2. Build shim + create worktree.
		const shim = buildMinimalIssue(event.issue);
		let workspace: Workspace;
		try {
			workspace = await this.gitService.createGitWorktree(shim, [repo]);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logger.error(`createGitWorktree failed for ${issueId}: ${msg}`);
			await this.tryComment(
				issueId,
				projectId,
				`<p>❌ No pude crear el workspace: ${escapeHtml(msg)}</p>`,
			);
			return;
		}

		// 3. Configure and run.
		const description =
			event.issue.description_stripped ??
			stripHtml(event.issue.description_html ?? "");
		const userPrompt = `Issue "${event.issue.name}":\n\n${description || "(sin descripción)"}\n\nImplementa lo pedido, commitea y abre un PR.`;

		await this.runWithStreaming({
			issueId,
			projectId,
			workspace,
			repo,
			userPrompt,
			resumeSessionId: undefined,
			workspaceSlug: event.workspaceSlug,
		});
	}

	async handleComment(
		event: Extract<PlaneAgentEvent, { type: "comment.created_on_bot_issue" }>,
		repo: RepositoryConfig,
		fullIssue: PlaneIssueRef,
	): Promise<void> {
		const issueId = event.issueId;
		const commentText =
			event.comment.comment_stripped ||
			stripHtml(event.comment.comment_html ?? "");
		const promptForRunner = `Nuevo comentario en el issue:\n\n${commentText}\n\nSi este comentario corrige o amplía la tarea, ajústate y continúa.`;

		// 1. Live runner → addStreamMessage.
		const live = this.active.get(issueId);
		if (
			live?.supportsStreamingInput &&
			typeof live.isRunning === "function" &&
			live.isRunning() &&
			typeof live.addStreamMessage === "function"
		) {
			try {
				live.addStreamMessage(promptForRunner);
				this.logger.info(
					`Plane comment streamed to live runner for issue ${issueId}`,
				);
				return;
			} catch (err) {
				this.logger.warn(
					`addStreamMessage failed for ${issueId}, falling back to resume: ${err instanceof Error ? err.message : String(err)}`,
				);
				// fall through to resume branch
			}
		}

		// 2. Dead runner with stored session id → spawn with resume.
		const stored = this.sessionStore.get(issueId);
		const resolvedProjectId = event.projectId || fullIssue.project;
		if (!stored) {
			this.logger.info(
				`Plane comment for ${issueId} has no prior session; asking the user to reassign.`,
			);
			await this.tryComment(
				issueId,
				resolvedProjectId,
				"<p>No tengo sesión previa para este issue. Vuélveme a asignar para empezar.</p>",
			);
			return;
		}

		this.logger.info(
			`Resuming Plane session for issue ${issueId} (claudeSessionId=${stored.claudeSessionId})`,
		);

		// 3. Recreate worktree (GitService is idempotent on existing).
		const shim = buildMinimalIssue(fullIssue);
		let workspace: Workspace;
		try {
			workspace = await this.gitService.createGitWorktree(shim, [repo]);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logger.error(
				`createGitWorktree (resume) failed for ${issueId}: ${msg}`,
			);
			await this.tryComment(
				issueId,
				resolvedProjectId,
				`<p>❌ No pude reabrir el workspace: ${escapeHtml(msg)}</p>`,
			);
			return;
		}

		await this.runWithStreaming({
			issueId,
			projectId: resolvedProjectId,
			workspace,
			repo,
			userPrompt: promptForRunner,
			resumeSessionId: stored.claudeSessionId,
			workspaceSlug: stored.workspaceSlug,
		});
	}

	async stop(): Promise<void> {
		for (const runner of this.active.values()) {
			if (typeof runner.stop === "function") {
				try {
					await runner.stop();
				} catch (err) {
					this.logger.error(
						`PlaneSessionRunner.stop: runner stop failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}
		this.active.clear();
	}

	/**
	 * Shared streaming runner lifecycle used by both handleAssignment and
	 * handleComment.
	 *
	 * Wires up the activity poster, persists the resulting Claude session id
	 * on complete, and ensures the issueId entry is removed from `active`
	 * regardless of how the runner ends.
	 */
	private async runWithStreaming(params: {
		issueId: string;
		projectId: string;
		workspace: Workspace;
		repo: RepositoryConfig;
		userPrompt: string;
		resumeSessionId: string | undefined;
		workspaceSlug: string;
	}): Promise<void> {
		const {
			issueId,
			projectId,
			workspace,
			repo,
			userPrompt,
			resumeSessionId,
			workspaceSlug,
		} = params;

		const poster = new PlaneClaudeActivityPoster({
			postComment: (html) =>
				this.planeIssueTracker.createComment(issueId, projectId, html),
			logger: this.logger,
		});

		const bypassPermissions = repo.planeBypassPermissions ?? true;
		const extraArgs: Record<string, string | null> = {
			...(bypassPermissions ? { "dangerously-skip-permissions": null } : {}),
			// Surface each Plane-driven session in claude.ai under the cyrus
			// OAuth account so the operator can observe runs remotely. The
			// flag is documented as "interactive" in the CLI help, but the
			// SDK forwards it in --print mode too — if the binary ignores it
			// the session continues normally with no remote visibility.
			"remote-control": null,
			"remote-control-session-name-prefix": `cyrus-plane-${repo.id}`,
		};

		const systemPrompt = buildSystemPrompt();

		const runnerHandle = this.claudeRunnerFactory({
			workingDirectory: workspace.path,
			cyrusHome: this.cyrusHome,
			systemPrompt,
			model: repo.model,
			fallbackModel: repo.fallbackModel,
			allowedTools: repo.allowedTools,
			disallowedTools: repo.disallowedTools,
			maxTurns: repo.planeMaxTurns ?? DEFAULT_MAX_TURNS,
			resumeSessionId,
			extraArgs,
		});
		this.active.set(issueId, runnerHandle);

		runnerHandle.on("message", (m: SDKMessage) => poster.handleMessage(m));
		runnerHandle.on("error", (e: Error) => poster.handleError(e));
		runnerHandle.on("complete", () => poster.handleComplete());

		try {
			await new Promise<void>((resolve) => {
				runnerHandle.once("complete", () => resolve());
				runnerHandle.startStreaming(userPrompt).catch((err) => {
					const msg = err instanceof Error ? err.message : String(err);
					this.logger.error(
						`ClaudeRunner.startStreaming failed for ${issueId}: ${msg}`,
					);
					poster.handleError(err instanceof Error ? err : new Error(msg));
					resolve();
				});
			});
			await poster.flush();
			await this.persistSessionId(
				runnerHandle,
				issueId,
				projectId,
				workspaceSlug,
			);
		} finally {
			this.active.delete(issueId);
		}
	}

	private async persistSessionId(
		runnerHandle: ClaudeRunnerHandle,
		issueId: string,
		projectId: string,
		workspaceSlug: string,
	): Promise<void> {
		const claudeSessionId = runnerHandle.getSessionInfo?.()?.sessionId;
		if (!claudeSessionId) {
			this.logger.warn(
				`No Claude session id available after run for issue ${issueId}; future comments will create a fresh session.`,
			);
			return;
		}
		try {
			await this.sessionStore.set(issueId, {
				claudeSessionId,
				projectId,
				workspaceSlug,
				updatedAt: Date.now(),
			});
		} catch (err) {
			this.logger.error(
				`Failed to persist Claude session id for ${issueId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	private async tryComment(
		issueId: string,
		projectId: string,
		html: string,
	): Promise<void> {
		try {
			await this.planeIssueTracker.createComment(issueId, projectId, html);
		} catch (err) {
			this.logger.error(
				`createComment (recovery) failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

function buildSystemPrompt(): string {
	return `Eres @builder, un agente que implementa issues asignados. Trabajas en una rama dedicada al issue, haces los cambios pedidos, commiteas y abres un PR contra origin/main. Si el usuario añade un comentario al issue mientras trabajas, considéralo como una nueva instrucción y ajústate a ella en el siguiente turno.`;
}

function buildMinimalIssue(issue: PlaneIssue | PlaneIssueRef): Issue {
	const identifier = `PFL-${issue.sequence_id}`;
	const branchName = sanitizeBranch(
		`plane-${issue.sequence_id}-${slugify(issue.name)}`,
	);
	const description =
		issue.description_stripped ?? stripHtml(issue.description_html ?? "");
	const stateId = extractStateId(issue);
	const emptyConnection = async () => ({
		nodes: [],
		pageInfo: { hasNextPage: false, hasPreviousPage: false },
	});
	return {
		id: issue.id,
		identifier,
		title: issue.name,
		description,
		url: "",
		branchName,
		assigneeId: undefined,
		stateId,
		teamId: issue.project,
		labelIds: issue.labels,
		priority: 0,
		createdAt: new Date(issue.created_at),
		updatedAt: new Date(issue.updated_at),
		archivedAt: null,
		state: undefined,
		assignee: undefined,
		team: undefined,
		parent: undefined,
		project: undefined,
		labels: emptyConnection,
		comments: emptyConnection,
		attachments: emptyConnection,
		children: emptyConnection,
		inverseRelations: emptyConnection,
		update: async () => undefined,
	} as unknown as Issue;
}

function extractStateId(issue: PlaneIssue | PlaneIssueRef): string {
	const state = (issue as { state: unknown }).state;
	if (typeof state === "string") return state;
	if (state && typeof state === "object" && "id" in state) {
		return (state as { id: string }).id;
	}
	return "";
}

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
}

function sanitizeBranch(s: string): string {
	return s
		.replace(/[`~^:?*[\]\\@{}\s!()]/g, "-")
		.replace(/\.{2,}/g, ".")
		.replace(/\/{2,}/g, "/")
		.replace(/^[.\-/]+/, "")
		.replace(/[.\-/]+$/, "")
		.replace(/-{2,}/g, "-");
}

function stripHtml(html: string): string {
	return html.replace(/<[^>]+>/g, "").trim();
}
