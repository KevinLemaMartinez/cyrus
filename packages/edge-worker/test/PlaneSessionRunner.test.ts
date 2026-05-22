import { EventEmitter } from "node:events";
import type { RepositoryConfig } from "cyrus-core";
import type {
	PlaneAgentEvent,
	PlaneIssueTrackerService,
} from "cyrus-plane-event-transport";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitService } from "../src/GitService.js";
import { PlaneSessionRunner } from "../src/PlaneSessionRunner.js";

const PROJECT_ID = "35502ab9-d5b6-4397-9917-732a69eb9dd4";
const ISSUE_ID = "a0f19eec-e6fd-414b-b5a0-57f14e13f043";

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

function buildRepo(): RepositoryConfig {
	return {
		id: "panfleet",
		name: "panfleet",
		repositoryPath: "/tmp/panfleet",
		baseBranch: "main",
		workspaceBaseDir: "/tmp/cyrus-workspaces",
		planeProjectId: PROJECT_ID,
	} as unknown as RepositoryConfig;
}

function buildMocks() {
	const gitService = {
		createGitWorktree: vi.fn(async () => ({
			path: "/tmp/cyrus-workspaces/PFL-7",
			isGitWorktree: true,
		})),
	} as unknown as GitService;

	const planeIssueTracker = {
		createComment: vi.fn(async () => ({})),
	} as unknown as PlaneIssueTrackerService;

	const fakeRunner = new EventEmitter() as EventEmitter & {
		start: ReturnType<typeof vi.fn>;
	};
	fakeRunner.start = vi.fn(async () => {
		// Synchronously fire complete on the next tick.
		setImmediate(() => fakeRunner.emit("complete", []));
		return { sessionId: "sess_1", startedAt: new Date(), isRunning: false };
	});

	const claudeRunnerFactory = vi.fn(() => fakeRunner);

	return { gitService, planeIssueTracker, fakeRunner, claudeRunnerFactory };
}

describe("PlaneSessionRunner", () => {
	let mocks: ReturnType<typeof buildMocks>;
	let runner: PlaneSessionRunner;

	beforeEach(() => {
		mocks = buildMocks();
		runner = new PlaneSessionRunner({
			gitService: mocks.gitService,
			planeIssueTracker: mocks.planeIssueTracker,
			claudeRunnerFactory: mocks.claudeRunnerFactory as never,
			cyrusHome: "/tmp/cyrus-home",
		});
	});

	it("runs the happy path: ack, worktree, ClaudeRunner.start", async () => {
		const event = buildAssignmentEvent();
		const repo = buildRepo();
		await runner.handleAssignment(event, repo);

		// 1. Acknowledge comment was posted.
		expect(mocks.planeIssueTracker.createComment).toHaveBeenCalledWith(
			ISSUE_ID,
			PROJECT_ID,
			expect.stringContaining("Recibí la asignación"),
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

		// 3. ClaudeRunner was constructed with the worktree path.
		expect(mocks.claudeRunnerFactory).toHaveBeenCalledTimes(1);
		const runnerConfig = (mocks.claudeRunnerFactory as ReturnType<typeof vi.fn>)
			.mock.calls[0]![0];
		expect(runnerConfig.workingDirectory).toBe("/tmp/cyrus-workspaces/PFL-7");
		expect(runnerConfig.cyrusHome).toBe("/tmp/cyrus-home");
		expect(mocks.fakeRunner.start).toHaveBeenCalledTimes(1);
	});

	it("posts an error comment and does not start ClaudeRunner when worktree creation fails", async () => {
		(
			mocks.gitService.createGitWorktree as ReturnType<typeof vi.fn>
		).mockRejectedValueOnce(new Error("disk full"));
		const event = buildAssignmentEvent();
		await runner.handleAssignment(event, buildRepo());

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

		await runner.handleAssignment(event, buildRepo());

		const [shim] = (
			mocks.gitService.createGitWorktree as ReturnType<typeof vi.fn>
		).mock.calls[0]!;
		expect(shim.identifier).toBe("PFL-42");
		expect(shim.branchName).toMatch(/^plane-42-add-a-health-endpoint/);
		// No invalid git ref characters.
		expect(shim.branchName).not.toMatch(/[!()`~^:?*\\[\]\s]/);
	});

	it("PlaneSessionRunner.stop() calls stop() on every in-flight runner", async () => {
		// Make the runner's start() hang so the runner stays in `active`.
		const stopMock = vi.fn();
		mocks.fakeRunner.start = vi.fn(() => new Promise(() => {})); // never resolves
		(
			mocks.fakeRunner as EventEmitter & { stop?: ReturnType<typeof vi.fn> }
		).stop = stopMock;

		const event = buildAssignmentEvent();
		const assignmentPromise = runner.handleAssignment(event, buildRepo());

		// Give the pipeline time to spawn the runner.
		await new Promise((r) => setTimeout(r, 50));

		await runner.stop();

		expect(stopMock).toHaveBeenCalledTimes(1);

		// Don't leave the unresolved promise hanging vitest.
		void assignmentPromise;
	});

	it("does not hang when ClaudeRunner.start() rejects", async () => {
		// Replace the runner's start with one that rejects synchronously.
		mocks.fakeRunner.start = vi.fn(async () => {
			throw new Error("Claude session already running");
		});

		const event = buildAssignmentEvent();

		// If the runner hangs, this will fail under vitest's default 5s timeout.
		const timedOut = new Promise<"timeout">((resolve) =>
			setTimeout(() => resolve("timeout"), 2000),
		);
		const finished = runner
			.handleAssignment(event, buildRepo())
			.then(() => "finished" as const);
		const winner = await Promise.race([finished, timedOut]);

		expect(winner).toBe("finished");

		// The poster should have received the error so a comment is queued.
		// Acknowledge + error from start rejection = 2 createComment calls.
		expect(mocks.planeIssueTracker.createComment).toHaveBeenCalledTimes(2);
		const calls = (
			mocks.planeIssueTracker.createComment as ReturnType<typeof vi.fn>
		).mock.calls;
		expect(calls[1]![2]).toContain("Error de Claude");
		expect(calls[1]![2]).toContain("Claude session already running");
	});
});
