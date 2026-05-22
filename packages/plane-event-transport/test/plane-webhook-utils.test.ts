import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	isAssignedToBot,
	translatePayload,
	verifyPlaneSignature,
} from "../src/plane-webhook-utils.js";
import type { PlaneIssue, PlaneWebhookEnvelope } from "../src/types.js";

const SECRET = "test-secret-xxx";
const BOT = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000099";

function sign(body: string): string {
	return createHmac("sha256", SECRET).update(body).digest("hex");
}

function fakeIssue(over: Partial<PlaneIssue> = {}): PlaneIssue {
	return {
		id: "11111111-1111-1111-1111-111111111111",
		name: "Test issue",
		description_html: null,
		description_stripped: null,
		priority: "none",
		state: "state-1",
		project: "proj-1",
		workspace: "ws-1",
		assignees: [],
		labels: [],
		sequence_id: 1,
		created_by: OTHER,
		updated_by: null,
		created_at: "2026-05-22T19:00:00Z",
		updated_at: "2026-05-22T19:00:00Z",
		...over,
	};
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
		const bad = sign(body).replace(/.$/, "0").replace(/.$/, "1"); // mutate
		expect(verifyPlaneSignature(body, bad, SECRET)).toBe(false);
	});

	it("returns false when signature header is missing", () => {
		expect(verifyPlaneSignature("anything", undefined, SECRET)).toBe(false);
	});
});

describe("isAssignedToBot", () => {
	it("true when bot is in assignees", () => {
		expect(isAssignedToBot(fakeIssue({ assignees: [OTHER, BOT] }), BOT)).toBe(
			true,
		);
	});

	it("false when bot is not in assignees", () => {
		expect(isAssignedToBot(fakeIssue({ assignees: [OTHER] }), BOT)).toBe(false);
	});
});

describe("translatePayload", () => {
	const ctx = { botUserId: BOT, workspaceSlug: "pulpparty" };

	it("emits issue.assigned_to_bot when bot is among assignees", () => {
		const env: PlaneWebhookEnvelope = {
			event: "issue",
			action: "updated",
			data: fakeIssue({ assignees: [BOT] }),
		};
		const result = translatePayload(env, ctx);
		expect(result).not.toBeNull();
		expect(result?.type).toBe("issue.assigned_to_bot");
	});

	it("returns null when issue is not assigned to bot", () => {
		const env: PlaneWebhookEnvelope = {
			event: "issue",
			action: "updated",
			data: fakeIssue({ assignees: [OTHER] }),
		};
		expect(translatePayload(env, ctx)).toBeNull();
	});

	it("drops comment events in POC (no multi-turn)", () => {
		const env: PlaneWebhookEnvelope = {
			event: "issue_comment",
			action: "created",
			data: { id: "c-1", issue: "i-1", actor: OTHER, comment_html: "hi" },
		};
		expect(translatePayload(env, ctx)).toBeNull();
	});
});
