import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlaneBotConfig, RepositoryConfig } from "cyrus-core";
import type {
	PlaneAgentEvent,
	PlaneIssueRef,
	PlaneIssueTrackerService,
} from "cyrus-plane-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitService } from "../src/GitService.js";
import { PlaneSessionRunner } from "../src/PlaneSessionRunner.js";
import { PlaneSessionStore } from "../src/PlaneSessionStore.js";

const PROJECT_ID = "35502ab9-d5b6-4397-9917-732a69eb9dd4";
const ISSUE_ID = "a0f19eec-e6fd-414b-b5a0-57f14e13f043";
const BUILDER_USER_ID = "3322520e-b959-4cbd-8b7c-929b05e445da";
const DESIGNER_USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function buildAssignmentEvent(): Extract<
	PlaneAgentEvent,
	{ type: "issue.assigned_to_bot" }
> {
	return {
		type: "issue.assigned_to_bot",
		projectId: PROJECT_ID,
		workspaceSlug: "panfleet",
		actor: {
			id: "u1",
			email: "kevin@pulp.lan",
			first_name: "Kevin",
			last_name: "",
			display_name: "kevin",
			avatar: "",
			avatar_url: null,
		},
		issue: {
			id: ISSUE_ID,
			name: "Add a /health endpoint",
			description_html: "<p>Return 200 OK and uptime.</p>",
			description_stripped: "Return 200 OK and uptime.",
			priority: "medium",
			project: PROJECT_ID,
			workspace: "ws1",
			labels: [],
			sequence_id: 7,
			created_by: "u1",
			updated_by: "u1",
			created_at: "2026-05-23T10:00:00Z",
			updated_at: "2026-05-23T10:00:00Z",
			deleted_at: null,
			is_draft: false,
			parent: null,
			target_date: null,
			start_date: null,
			completed_at: null,
			archived_at: null,
			state: { id: "s1", name: "Todo", color: "#ccc", group: "unstarted" },
			assignees: [],
		},
	};
}

function buildCommentEvent(): Extract<
	PlaneAgentEvent,
	{ type: "comment.created_on_bot_issue" }
> {
	return {
		type: "comment.created_on_bot_issue",
		issueId: ISSUE_ID,
		comment: {
			id: "comment-1",
			issue: ISSUE_ID,
			actor: "u1",
			comment_html: "<p>please also add unit tests</p>",
			comment_stripped: "please also add unit tests",
			created_at: "2026-05-24T11:00:00Z",
			updated_at: "2026-05-24T11:00:00Z",
		},
		projectId: PROJECT_ID,
		workspaceSlug: "panfleet",
		actor: {
			id: "u1",
			email: "",
			first_name: "",
			last_name: "",
			display_name: "",
			avatar: "",
			avatar_url: null,
		},
	};
}

function buildFullIssueRef(): PlaneIssueRef {
	return {
		id: ISSUE_ID,
		name: "Add a /health endpoint",
		description_html: "<p>Return 200 OK and uptime.</p>",
		description_stripped: "Return 200 OK and uptime.",
		priority: "medium",
		project: PROJECT_ID,
		workspace: "ws1",
		labels: [],
		sequence_id: 7,
		created_by: "u1",
		updated_by: "u1",
		created_at: "2026-05-23T10:00:00Z",
		updated_at: "2026-05-24T11:00:00Z",
		deleted_at: null,
		is_draft: false,
		parent: null,
		target_date: null,
		start_date: null,
		completed_at: null,
		archived_at: null,
		state: "s1",
		assignees: [BUILDER_USER_ID],
	};
}

function buildRepo(planeBots?: PlaneBotConfig[]): RepositoryConfig {
	return {
		id: "panfleet",
		name: "panfleet",
		repositoryPath: "/tmp/panfleet",
		baseBranch: "main",
		workspaceBaseDir: "/tmp/cyrus-workspaces",
		planeProjectId: PROJECT_ID,
		...(planeBots ? { planeBots } : {}),
	} as unknown as RepositoryConfig;
}

function buildBuilderBot(
	overrides: Partial<PlaneBotConfig> = {},
): PlaneBotConfig {
	return {
		role: "builder",
		userId: BUILDER_USER_ID,
		token: "plane_api_builder",
		systemPrompt: "You are @builder. You implement issues and open PRs.",
		...overrides,
	};
}

function buildDesignerBot(
	overrides: Partial<PlaneBotConfig> = {},
): PlaneBotConfig {
	return {
		role: "designer",
		userId: DESIGNER_USER_ID,
		token: "plane_api_designer",
		systemPrompt: "You are @designer. You work on Figma.",
		allowedTools: ["Read", "mcp__figma__*", "mcp__plane__*"],
		disallowedTools: ["Edit", "Write", "Bash"],
		mcpConfigPath: "/home/cyrus/.cyrus/mcp-configs/designer.json",
		maxTurns: 25,
		bypassPermissions: true,
		...overrides,
	};
}

function makeFakeRunner(opts: { sessionId?: string | null } = {}) {
	const runner = new EventEmitter() as EventEmitter & {
		start: ReturnType<typeof vi.fn>;
		startStreaming: ReturnType<typeof vi.fn>;
		addStreamMessage: ReturnType<typeof vi.fn>;
		completeStream: ReturnType<typeof vi.fn>;
		stop?: ReturnType<typeof vi.fn>;
		isRunning: ReturnType<typeof vi.fn>;
		supportsStreamingInput: boolean;
		getSessionInfo: ReturnType<typeof vi.fn>;
	};
	const sessionId =
		opts.sessionId === undefined ? "claude-session-test" : opts.sessionId;
	runner.start = vi.fn(async () => {
		setImmediate(() => runner.emit("complete", []));
		return { sessionId, startedAt: new Date(), isRunning: false };
	});
	runner.startStreaming = vi.fn(async () => {
		setImmediate(() => runner.emit("complete", []));
		return { sessionId, startedAt: new Date(), isRunning: false };
	});
	runner.addStreamMessage = vi.fn();
	runner.completeStream = vi.fn();
	runner.stop = vi.fn();
	runner.isRunning = vi.fn(() => false);
	runner.supportsStreamingInput = true;
	runner.getSessionInfo = vi.fn(() =>
		sessionId === null ? null : { sessionId },
	);
	return runner;
}

function buildMocks(opts: { sessionId?: string | null } = {}) {
	const gitService = {
		createGitWorktree: vi.fn(async () => ({
			path: "/tmp/cyrus-workspaces/PFL-7",
			isGitWorktree: true,
		})),
	} as unknown as GitService;

	const planeIssueTracker = {
		createComment: vi.fn(async () => ({})),
	} as unknown as PlaneIssueTrackerService;

	const fakeRunner = makeFakeRunner(opts);
	const claudeRunnerFactory = vi.fn(() => fakeRunner);

	return { gitService, planeIssueTracker, fakeRunner, claudeRunnerFactory };
}

describe("PlaneSessionRunner", () => {
	let mocks: ReturnType<typeof buildMocks>;
	let runner: PlaneSessionRunner;
	let sessionStore: PlaneSessionStore;
	let tmpHomeDir: string;

	beforeEach(async () => {
		tmpHomeDir = await mkdtemp(join(tmpdir(), "plane-runner-test-"));
		sessionStore = new PlaneSessionStore({
			storePath: join(tmpHomeDir, "sessions.json"),
		});
		await sessionStore.load();

		mocks = buildMocks();
		runner = new PlaneSessionRunner({
			gitService: mocks.gitService,
			planeIssueTracker: mocks.planeIssueTracker,
			claudeRunnerFactory: mocks.claudeRunnerFactory as never,
			sessionStore,
			cyrusHome: tmpHomeDir,
		});
	});

	afterEach(async () => {
		await rm(tmpHomeDir, { recursive: true, force: true });
	});

	it("runs the happy path: ack, worktree, ClaudeRunner.startStreaming", async () => {
		const event = buildAssignmentEvent();
		const repo = buildRepo();
		const bot = buildBuilderBot();
		await runner.handleAssignment(event, repo, bot);

		// 1. Acknowledge comment was posted with the bot's token.
		expect(mocks.planeIssueTracker.createComment).toHaveBeenCalledWith(
			ISSUE_ID,
			PROJECT_ID,
			expect.stringContaining("He recibido la asignación"),
			{ tokenOverride: "plane_api_builder" },
		);

		// 2. Worktree was created with a MinimalIssue.
		expect(mocks.gitService.createGitWorktree).toHaveBeenCalledTimes(1);
		const [shim, repos] = (
			mocks.gitService.createGitWorktree as ReturnType<typeof vi.fn>
		).mock.calls[0]!;
		expect(shim.id).toBe(ISSUE_ID);
		expect(shim.identifier).toBe("PFL-7");
		expect(shim.title).toBe("Add a /health endpoint");
		expect(repos).toEqual([repo]);

		// 3. ClaudeRunner was constructed with the worktree path and started via streaming.
		expect(mocks.claudeRunnerFactory).toHaveBeenCalledTimes(1);
		const runnerConfig = (mocks.claudeRunnerFactory as ReturnType<typeof vi.fn>)
			.mock.calls[0]![0];
		expect(runnerConfig.workingDirectory).toBe("/tmp/cyrus-workspaces/PFL-7");
		expect(runnerConfig.cyrusHome).toBe(tmpHomeDir);
		expect(mocks.fakeRunner.startStreaming).toHaveBeenCalledTimes(1);
		expect(mocks.fakeRunner.start).not.toHaveBeenCalled();
	});

	it("posts an error comment and does not start ClaudeRunner when worktree creation fails", async () => {
		(
			mocks.gitService.createGitWorktree as ReturnType<typeof vi.fn>
		).mockRejectedValueOnce(new Error("disk full"));
		const event = buildAssignmentEvent();
		await runner.handleAssignment(event, buildRepo(), buildBuilderBot());

		// Acknowledge + error comment.
		expect(mocks.planeIssueTracker.createComment).toHaveBeenCalledTimes(2);
		const calls = (
			mocks.planeIssueTracker.createComment as ReturnType<typeof vi.fn>
		).mock.calls;
		expect(calls[1]![2]).toContain("No pude crear el workspace");
		expect(calls[1]![2]).toContain("disk full");

		// ClaudeRunner was never constructed.
		expect(mocks.claudeRunnerFactory).not.toHaveBeenCalled();
	});

	it("MinimalIssue shim has the expected synthetic branch name and slug", async () => {
		const event = buildAssignmentEvent();
		event.issue.name = "Add a /health endpoint!! (urgent)";
		event.issue.sequence_id = 42;

		await runner.handleAssignment(event, buildRepo(), buildBuilderBot());

		const [shim] = (
			mocks.gitService.createGitWorktree as ReturnType<typeof vi.fn>
		).mock.calls[0]!;
		expect(shim.identifier).toBe("PFL-42");
		expect(shim.branchName).toMatch(/^plane-42-add-a-health-endpoint/);
		// No invalid git ref characters.
		expect(shim.branchName).not.toMatch(/[!()`~^:?*\\[\]\s]/);
	});

	it("PlaneSessionRunner.stop() calls stop() on every in-flight runner", async () => {
		mocks.fakeRunner.startStreaming = vi.fn(() => new Promise(() => {}));

		const event = buildAssignmentEvent();
		const assignmentPromise = runner.handleAssignment(
			event,
			buildRepo(),
			buildBuilderBot(),
		);

		await new Promise((r) => setTimeout(r, 50));

		await runner.stop();

		expect(mocks.fakeRunner.stop).toHaveBeenCalledTimes(1);

		void assignmentPromise;
	});

	it("does not hang when ClaudeRunner.startStreaming() rejects", async () => {
		mocks.fakeRunner.startStreaming = vi.fn(async () => {
			throw new Error("Claude session already running");
		});

		const event = buildAssignmentEvent();

		const timedOut = new Promise<"timeout">((resolve) =>
			setTimeout(() => resolve("timeout"), 2000),
		);
		const finished = runner
			.handleAssignment(event, buildRepo(), buildBuilderBot())
			.then(() => "finished" as const);
		const winner = await Promise.race([finished, timedOut]);

		expect(winner).toBe("finished");

		expect(mocks.planeIssueTracker.createComment).toHaveBeenCalledTimes(2);
		const calls = (
			mocks.planeIssueTracker.createComment as ReturnType<typeof vi.fn>
		).mock.calls;
		expect(calls[1]![2]).toContain("Error de Claude");
		expect(calls[1]![2]).toContain("Claude session already running");
	});

	it("persists the Claude session id AND botUserId in PlaneSessionStore after complete", async () => {
		mocks.fakeRunner.getSessionInfo = vi.fn(() => ({
			sessionId: "claude-session-XYZ",
		}));
		const bot = buildDesignerBot();
		await runner.handleAssignment(buildAssignmentEvent(), buildRepo(), bot);
		const stored = sessionStore.get(ISSUE_ID);
		expect(stored?.claudeSessionId).toBe("claude-session-XYZ");
		expect(stored?.projectId).toBe(PROJECT_ID);
		expect(stored?.workspaceSlug).toBe("panfleet");
		expect(stored?.botUserId).toBe(DESIGNER_USER_ID);
	});

	describe("bot-driven config", () => {
		it("uses bot.systemPrompt (not a hardcoded @builder one)", async () => {
			const bot = buildDesignerBot();
			await runner.handleAssignment(buildAssignmentEvent(), buildRepo(), bot);
			const passedConfig = (
				mocks.claudeRunnerFactory as ReturnType<typeof vi.fn>
			).mock.calls[0]![0] as { systemPrompt?: string };
			expect(passedConfig.systemPrompt).toBe(
				"You are @designer. You work on Figma.",
			);
		});

		it("forwards bot.allowedTools and bot.disallowedTools", async () => {
			const bot = buildDesignerBot();
			await runner.handleAssignment(buildAssignmentEvent(), buildRepo(), bot);
			const passedConfig = (
				mocks.claudeRunnerFactory as ReturnType<typeof vi.fn>
			).mock.calls[0]![0] as {
				allowedTools?: string[];
				disallowedTools?: string[];
			};
			expect(passedConfig.allowedTools).toEqual([
				"Read",
				"mcp__figma__*",
				"mcp__plane__*",
			]);
			expect(passedConfig.disallowedTools).toEqual(["Edit", "Write", "Bash"]);
		});

		it("forwards bot.mcpConfigPath (not repo.mcpConfigPath)", async () => {
			const bot = buildDesignerBot();
			await runner.handleAssignment(
				buildAssignmentEvent(),
				{
					...buildRepo(),
					mcpConfigPath: "/should/not/be/used",
				} as unknown as RepositoryConfig,
				bot,
			);
			const passedConfig = (
				mocks.claudeRunnerFactory as ReturnType<typeof vi.fn>
			).mock.calls[0]![0] as { mcpConfigPath?: string };
			expect(passedConfig.mcpConfigPath).toBe(
				"/home/cyrus/.cyrus/mcp-configs/designer.json",
			);
		});

		it("uses bot.maxTurns when set", async () => {
			const bot = buildDesignerBot({ maxTurns: 7 });
			await runner.handleAssignment(buildAssignmentEvent(), buildRepo(), bot);
			const passedConfig = (
				mocks.claudeRunnerFactory as ReturnType<typeof vi.fn>
			).mock.calls[0]![0] as { maxTurns?: number };
			expect(passedConfig.maxTurns).toBe(7);
		});

		it("defaults maxTurns to 40 when bot.maxTurns is undefined", async () => {
			const bot = buildBuilderBot(); // no maxTurns set
			await runner.handleAssignment(buildAssignmentEvent(), buildRepo(), bot);
			const passedConfig = (
				mocks.claudeRunnerFactory as ReturnType<typeof vi.fn>
			).mock.calls[0]![0] as { maxTurns?: number };
			expect(passedConfig.maxTurns).toBe(40);
		});

		it("respects bot.bypassPermissions=false (no extraArgs flag)", async () => {
			const bot = buildBuilderBot({ bypassPermissions: false });
			await runner.handleAssignment(buildAssignmentEvent(), buildRepo(), bot);
			const passedConfig = (
				mocks.claudeRunnerFactory as ReturnType<typeof vi.fn>
			).mock.calls[0]![0] as { extraArgs?: Record<string, unknown> };
			expect(passedConfig.extraArgs).toEqual({});
		});

		it("defaults bypassPermissions to true (sets the extraArgs flag)", async () => {
			const bot = buildBuilderBot(); // bypassPermissions undefined
			await runner.handleAssignment(buildAssignmentEvent(), buildRepo(), bot);
			const passedConfig = (
				mocks.claudeRunnerFactory as ReturnType<typeof vi.fn>
			).mock.calls[0]![0] as { extraArgs?: Record<string, unknown> };
			expect(passedConfig.extraArgs).toEqual({
				"dangerously-skip-permissions": null,
			});
		});
	});

	describe("handleComment", () => {
		it("addStreamMessage on the live runner when one exists for the issue", async () => {
			mocks.fakeRunner.isRunning = vi.fn(() => true);
			(runner as unknown as { active: Map<string, unknown> }).active.set(
				ISSUE_ID,
				mocks.fakeRunner,
			);
			await runner.handleComment(
				buildCommentEvent(),
				buildRepo(),
				buildFullIssueRef(),
				buildBuilderBot(),
			);
			expect(mocks.fakeRunner.addStreamMessage).toHaveBeenCalledWith(
				expect.stringContaining("please also add unit tests"),
			);
			expect(mocks.fakeRunner.startStreaming).not.toHaveBeenCalled();
		});

		it("spawns a new runner with resumeSessionId when stored botUserId matches resolved bot", async () => {
			await sessionStore.set(ISSUE_ID, {
				claudeSessionId: "claude-session-prev",
				projectId: PROJECT_ID,
				workspaceSlug: "panfleet",
				botUserId: BUILDER_USER_ID,
				updatedAt: Date.now(),
			});
			await runner.handleComment(
				buildCommentEvent(),
				buildRepo(),
				buildFullIssueRef(),
				buildBuilderBot(),
			);
			expect(mocks.claudeRunnerFactory).toHaveBeenCalledTimes(1);
			const passedConfig = (
				mocks.claudeRunnerFactory as ReturnType<typeof vi.fn>
			).mock.calls[0]![0] as { resumeSessionId?: string };
			expect(passedConfig.resumeSessionId).toBe("claude-session-prev");
			expect(mocks.fakeRunner.startStreaming).toHaveBeenCalled();
		});

		it("spawns FRESH (no resumeSessionId) when stored botUserId differs from resolved bot", async () => {
			await sessionStore.set(ISSUE_ID, {
				claudeSessionId: "claude-session-builder-old",
				projectId: PROJECT_ID,
				workspaceSlug: "panfleet",
				botUserId: BUILDER_USER_ID,
				updatedAt: Date.now(),
			});
			// Resolved bot is now the designer.
			await runner.handleComment(
				buildCommentEvent(),
				buildRepo(),
				buildFullIssueRef(),
				buildDesignerBot(),
			);
			expect(mocks.claudeRunnerFactory).toHaveBeenCalledTimes(1);
			const passedConfig = (
				mocks.claudeRunnerFactory as ReturnType<typeof vi.fn>
			).mock.calls[0]![0] as { resumeSessionId?: string };
			expect(passedConfig.resumeSessionId).toBeUndefined();
		});

		it("spawns FRESH when stored entry has no botUserId (legacy entry)", async () => {
			await sessionStore.set(ISSUE_ID, {
				claudeSessionId: "claude-session-legacy",
				projectId: PROJECT_ID,
				workspaceSlug: "panfleet",
				updatedAt: Date.now(),
			});
			await runner.handleComment(
				buildCommentEvent(),
				buildRepo(),
				buildFullIssueRef(),
				buildBuilderBot(),
			);
			expect(mocks.claudeRunnerFactory).toHaveBeenCalledTimes(1);
			const passedConfig = (
				mocks.claudeRunnerFactory as ReturnType<typeof vi.fn>
			).mock.calls[0]![0] as { resumeSessionId?: string };
			expect(passedConfig.resumeSessionId).toBeUndefined();
		});

		it("posts 'reassign to start' and does not spawn when no prior session exists", async () => {
			await runner.handleComment(
				buildCommentEvent(),
				buildRepo(),
				buildFullIssueRef(),
				buildBuilderBot(),
			);
			expect(mocks.claudeRunnerFactory).not.toHaveBeenCalled();
			expect(mocks.planeIssueTracker.createComment).toHaveBeenCalledWith(
				ISSUE_ID,
				PROJECT_ID,
				expect.stringMatching(/vuélveme a asignar/i),
				{ tokenOverride: "plane_api_builder" },
			);
		});

		it("recovery comment on worktree failure uses the bot's token", async () => {
			await sessionStore.set(ISSUE_ID, {
				claudeSessionId: "claude-session-prev",
				projectId: PROJECT_ID,
				workspaceSlug: "panfleet",
				botUserId: DESIGNER_USER_ID,
				updatedAt: Date.now(),
			});
			(
				mocks.gitService.createGitWorktree as ReturnType<typeof vi.fn>
			).mockRejectedValueOnce(new Error("disk full"));
			await runner.handleComment(
				buildCommentEvent(),
				buildRepo(),
				buildFullIssueRef(),
				buildDesignerBot(),
			);
			const calls = (
				mocks.planeIssueTracker.createComment as ReturnType<typeof vi.fn>
			).mock.calls;
			const errorCall = calls.find((c) =>
				String(c[2]).includes("No pude reabrir"),
			);
			expect(errorCall).toBeDefined();
			expect(errorCall![3]).toEqual({ tokenOverride: "plane_api_designer" });
		});
	});
});
