/**
 * PlaneSessionRunner — orchestrates the Plane CE pipeline for an assignment.
 *
 *   1. Posts an acknowledge comment on the Plane issue.
 *   2. Builds a MinimalIssue shim that the existing GitService can consume.
 *   3. Creates a git worktree for the issue.
 *   4. Spawns a ClaudeRunner with a PlaneClaudeActivityPoster wired to its
 *      events. The runner's lifecycle ends when ClaudeRunner emits
 *      "complete" — there is no automated cleanup of the worktree in POC.
 *
 * Dependencies are injected so the runner can be tested without a real
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
	PlaneIssueTrackerService,
} from "cyrus-plane-event-transport";
import type { GitService } from "./GitService.js";
import { PlaneClaudeActivityPoster } from "./PlaneClaudeActivityPoster.js";
import { escapeHtml } from "./plane-html-utils.js";

export type ClaudeRunnerHandle = EventEmitter & {
	start: (prompt: string) => Promise<unknown>;
	stop?: () => void | Promise<void>;
};

export type ClaudeRunnerFactory = (
	config: ClaudeRunnerConfig,
) => ClaudeRunnerHandle;

export interface PlaneSessionRunnerConfig {
	gitService: GitService;
	planeIssueTracker: PlaneIssueTrackerService;
	claudeRunnerFactory: ClaudeRunnerFactory;
	cyrusHome: string;
	logger?: ILogger;
}

export class PlaneSessionRunner {
	private readonly gitService: GitService;
	private readonly planeIssueTracker: PlaneIssueTrackerService;
	private readonly claudeRunnerFactory: ClaudeRunnerFactory;
	private readonly cyrusHome: string;
	private readonly logger: ILogger;
	private readonly active: Set<ClaudeRunnerHandle> = new Set();

	constructor(config: PlaneSessionRunnerConfig) {
		this.gitService = config.gitService;
		this.planeIssueTracker = config.planeIssueTracker;
		this.claudeRunnerFactory = config.claudeRunnerFactory;
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
				"<p>👋 Recibí la asignación, arrancando…</p>",
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

		// 3. Configure and start ClaudeRunner with poster wired up.
		const poster = new PlaneClaudeActivityPoster({
			postComment: (html) =>
				this.planeIssueTracker.createComment(issueId, projectId, html),
			logger: this.logger,
		});

		const description =
			event.issue.description_stripped ??
			stripHtml(event.issue.description_html ?? "");
		const systemPrompt = `Sos @builder. Estás trabajando en el issue "${event.issue.name}". Descripción:\n${description}\n\nImplementá lo pedido, commiteá y abrí un PR a origin/main.`;

		const runnerHandle = this.claudeRunnerFactory({
			workingDirectory: workspace.path,
			cyrusHome: this.cyrusHome,
			systemPrompt,
			model: repo.model,
			fallbackModel: repo.fallbackModel,
			allowedTools: repo.allowedTools,
			disallowedTools: repo.disallowedTools,
		});
		this.active.add(runnerHandle);

		runnerHandle.on("message", (m: SDKMessage) => poster.handleMessage(m));
		runnerHandle.on("error", (e: Error) => poster.handleError(e));
		runnerHandle.on("complete", () => poster.handleComplete());

		try {
			await new Promise<void>((resolve) => {
				runnerHandle.once("complete", () => resolve());
				runnerHandle.start("").catch((err) => {
					const msg = err instanceof Error ? err.message : String(err);
					this.logger.error(`ClaudeRunner.start failed for ${issueId}: ${msg}`);
					poster.handleError(err instanceof Error ? err : new Error(msg));
					resolve();
				});
			});
			await poster.flush();
		} finally {
			this.active.delete(runnerHandle);
		}
	}

	async stop(): Promise<void> {
		for (const runner of this.active) {
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

function buildMinimalIssue(issue: PlaneIssue): Issue {
	const identifier = `PFL-${issue.sequence_id}`;
	const branchName = sanitizeBranch(
		`plane-${issue.sequence_id}-${slugify(issue.name)}`,
	);
	const description =
		issue.description_stripped ?? stripHtml(issue.description_html ?? "");
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
		stateId: issue.state.id,
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
