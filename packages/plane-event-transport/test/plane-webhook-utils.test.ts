import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	isAssignedToBot,
	translatePayload,
	verifyPlaneSignature,
	wasJustAssignedToBot,
} from "../src/plane-webhook-utils.js";
import type { PlaneIssue, PlaneWebhookEnvelope } from "../src/types.js";

const SECRET = "test-secret-xxx";
const BOT = "3322520e-b959-4cbd-8b7c-929b05e445da"; // matches fixture
const OTHER = "00000000-0000-0000-0000-000000000099";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): {
	rawBody: string;
	envelope: PlaneWebhookEnvelope;
} {
	const path = resolve(__dirname, "fixtures", name);
	const rawBody = readFileSync(path, "utf8");
	return { rawBody, envelope: JSON.parse(rawBody) as PlaneWebhookEnvelope };
}

function sign(body: string): string {
	return createHmac("sha256", SECRET).update(body).digest("hex");
}

describe("verifyPlaneSignature", () => {
	it("returns true with a matching signature", () => {
		const body = JSON.stringify({
			event: "issue",
			action: "updated",
			data: {},
		});
		expect(verifyPlaneSignature(body, sign(body), SECRET)).toBe(true);
	});

	it("returns false when signature mismatches", () => {
		const body = JSON.stringify({
			event: "issue",
			action: "updated",
			data: {},
		});
		const mutated = `${sign(body).slice(0, -2)}00`;
		expect(verifyPlaneSignature(body, mutated, SECRET)).toBe(false);
	});

	it("returns false when signature header is missing", () => {
		expect(verifyPlaneSignature("anything", undefined, SECRET)).toBe(false);
	});
});

describe("real Plane payloads", () => {
	it("issue-created fixture: bot is not yet assigned, no event emitted", () => {
		const { envelope } = loadFixture("issue-created.json");
		expect(envelope.event).toBe("issue");
		expect(envelope.action).toBe("created");
		const issue = envelope.data as PlaneIssue;
		expect(issue.assignees).toEqual([]);
		expect(
			translatePayload(envelope, {
				botUserIds: [BOT],
				workspaceSlug: "panfleet",
			}),
		).toBeNull();
	});

	it("issue-updated-assigned-to-bot fixture: emits issue.assigned_to_bot", () => {
		const { envelope } = loadFixture("issue-updated-assigned-to-bot.json");
		expect(envelope.event).toBe("issue");
		expect(envelope.action).toBe("updated");
		expect(envelope.activity?.field).toBe("assignee_ids");

		const issue = envelope.data as PlaneIssue;
		expect(isAssignedToBot(issue, BOT)).toBe(true);
		expect(wasJustAssignedToBot(envelope.activity, BOT)).toBe(true);

		const result = translatePayload(envelope, {
			botUserIds: [BOT],
			workspaceSlug: "panfleet",
		});
		expect(result).not.toBeNull();
		expect(result?.type).toBe("issue.assigned_to_bot");
		if (result?.type === "issue.assigned_to_bot") {
			expect(result.issue.name).toBe("Prueba webhook");
			expect(result.projectId).toBe("35502ab9-d5b6-4397-9917-732a69eb9dd4");
			expect(result.workspaceSlug).toBe("panfleet");
			// activity.actor is the user who made the change (kevin), not the bot
			expect(result.actor.email).toBe("kevin.soesto@gmail.com");
		}
	});
});

describe("wasJustAssignedToBot", () => {
	it("true when bot is in new_value and not in old_value", () => {
		expect(
			wasJustAssignedToBot(
				{
					field: "assignee_ids",
					new_value: [BOT, OTHER],
					old_value: [OTHER],
					actor: stubActor(),
					old_identifier: null,
					new_identifier: null,
				},
				BOT,
			),
		).toBe(true);
	});

	it("false when bot was already assigned (no change for the bot)", () => {
		expect(
			wasJustAssignedToBot(
				{
					field: "assignee_ids",
					new_value: [BOT, OTHER],
					old_value: [BOT],
					actor: stubActor(),
					old_identifier: null,
					new_identifier: null,
				},
				BOT,
			),
		).toBe(false);
	});

	it("false when the diff is for a different field", () => {
		expect(
			wasJustAssignedToBot(
				{
					field: "labels",
					new_value: ["label-1"],
					old_value: [],
					actor: stubActor(),
					old_identifier: null,
					new_identifier: null,
				},
				BOT,
			),
		).toBe(false);
	});

	it("false when activity is undefined", () => {
		expect(wasJustAssignedToBot(undefined, BOT)).toBe(false);
	});
});

describe("translatePayload — issue_comment events", () => {
	const ctx = {
		botUserIds: [BOT],
		workspaceSlug: "panfleet",
	};

	const baseEnvelope = (
		overrides: Partial<PlaneWebhookEnvelope<unknown>> = {},
	): PlaneWebhookEnvelope => ({
		event: "issue_comment",
		action: "created",
		webhook_id: "wh-1",
		workspace_id: "ws-1",
		data: {
			id: "comment-1",
			issue: "issue-1",
			actor: OTHER,
			comment_html: "<p>hello</p>",
			comment_stripped: "hello",
			created_at: "2026-05-24T10:00:00Z",
			updated_at: "2026-05-24T10:00:00Z",
		},
		...overrides,
	});

	it("emits comment.created_on_bot_issue when a non-bot user posts a comment", () => {
		const env = baseEnvelope();
		const result = translatePayload(env, ctx);
		expect(result).not.toBeNull();
		expect(result?.type).toBe("comment.created_on_bot_issue");
		if (result?.type !== "comment.created_on_bot_issue") return;
		expect(result.issueId).toBe("issue-1");
		expect(result.comment.id).toBe("comment-1");
		expect(result.workspaceSlug).toBe("panfleet");
		expect(result.actor.id).toBe(OTHER);
	});

	it("returns null when the comment author is the bot (anti-loop)", () => {
		const env = baseEnvelope({
			data: {
				id: "comment-1",
				issue: "issue-1",
				actor: BOT,
				comment_html: "<p>self</p>",
				comment_stripped: "self",
				created_at: "2026-05-24T10:00:00Z",
				updated_at: "2026-05-24T10:00:00Z",
			},
		});
		expect(translatePayload(env, ctx)).toBeNull();
	});

	it("returns null when action is not 'created'", () => {
		const env = baseEnvelope({ action: "updated" });
		expect(translatePayload(env, ctx)).toBeNull();
	});
});

describe("translatePayload with multiple botUserIds", () => {
	const BOT_BUILDER = BOT;
	const BOT_DESIGNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

	it("emits when any of the configured bots is the new assignee", () => {
		const { envelope } = loadFixture("issue-updated-assigned-to-bot.json");
		// Fixture has builder as the new assignee; both bots are configured.
		const result = translatePayload(envelope, {
			botUserIds: [BOT_DESIGNER, BOT_BUILDER],
			workspaceSlug: "panfleet",
		});
		expect(result).not.toBeNull();
		expect(result?.type).toBe("issue.assigned_to_bot");
	});

	it("emits with single-bot configuration via botUserIds (back-compat shape)", () => {
		const { envelope } = loadFixture("issue-updated-assigned-to-bot.json");
		const result = translatePayload(envelope, {
			botUserIds: [BOT_BUILDER],
			workspaceSlug: "panfleet",
		});
		expect(result).not.toBeNull();
	});

	it("returns null when none of the configured bots is in the new assignees", () => {
		const { envelope } = loadFixture("issue-updated-assigned-to-bot.json");
		const result = translatePayload(envelope, {
			botUserIds: [BOT_DESIGNER, "11111111-1111-4111-8111-111111111111"],
			workspaceSlug: "panfleet",
		});
		expect(result).toBeNull();
	});

	it("comment anti-loop: drops comments authored by ANY configured bot", () => {
		const env: PlaneWebhookEnvelope = {
			event: "issue_comment",
			action: "created",
			webhook_id: "wh-1",
			workspace_id: "ws-1",
			data: {
				id: "comment-1",
				issue: "issue-1",
				actor: BOT_DESIGNER,
				comment_html: "<p>self</p>",
				comment_stripped: "self",
				created_at: "2026-05-24T10:00:00Z",
				updated_at: "2026-05-24T10:00:00Z",
			},
		};
		const result = translatePayload(env, {
			botUserIds: [BOT_BUILDER, BOT_DESIGNER],
			workspaceSlug: "panfleet",
		});
		expect(result).toBeNull();
	});

	it("comment anti-loop: emits when commenter is not a bot", () => {
		const env: PlaneWebhookEnvelope = {
			event: "issue_comment",
			action: "created",
			webhook_id: "wh-1",
			workspace_id: "ws-1",
			data: {
				id: "comment-1",
				issue: "issue-1",
				actor: OTHER,
				comment_html: "<p>human</p>",
				comment_stripped: "human",
				created_at: "2026-05-24T10:00:00Z",
				updated_at: "2026-05-24T10:00:00Z",
			},
		};
		const result = translatePayload(env, {
			botUserIds: [BOT_BUILDER, BOT_DESIGNER],
			workspaceSlug: "panfleet",
		});
		expect(result).not.toBeNull();
	});
});

function stubActor() {
	return {
		id: "stub",
		email: "stub@example.com",
		first_name: "Stub",
		last_name: "Actor",
		display_name: "stub",
		avatar: "",
		avatar_url: null,
	};
}
