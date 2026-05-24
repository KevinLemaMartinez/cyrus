/**
 * Black-box tests for the plane-bot resolution and validation helpers used
 * by EdgeWorker.registerPlaneEventTransport() and EdgeWorker.handlePlaneEvent().
 *
 * Same pattern as EdgeWorker.plane-comment-routing.test.ts: helpers are
 * module-scope private in EdgeWorker.ts to keep its surface small. We
 * re-declare the logic here and rely on the LXC smoke test to catch drift.
 */
import type { PlaneBotConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";

function resolveBotForAssignees(
	assignees: string[],
	planeBots: PlaneBotConfig[] | undefined,
): { bot: PlaneBotConfig | undefined; multiple: boolean } {
	if (!planeBots || planeBots.length === 0)
		return { bot: undefined, multiple: false };
	const matched = planeBots.filter((b) => assignees.includes(b.userId));
	return {
		bot: matched[0],
		multiple: matched.length > 1,
	};
}

type RepoLike = {
	id: string;
	planeProjectId?: string;
	planeBots?: PlaneBotConfig[];
};

type ValidationResult = {
	ok: boolean;
	errors: string[];
	botUserIds: string[];
};

function validatePlaneRepos(repos: RepoLike[]): ValidationResult {
	const errors: string[] = [];
	const seen = new Map<string, string>(); // userId → repo.id
	const botUserIds: string[] = [];
	for (const repo of repos) {
		if (!repo.planeProjectId) continue;
		const bots = repo.planeBots ?? [];
		if (bots.length === 0) {
			errors.push(
				`Repository '${repo.id}' has planeProjectId but no planeBots[]`,
			);
			continue;
		}
		for (const b of bots) {
			if (seen.has(b.userId)) {
				errors.push(
					`Bot userId ${b.userId} is configured in both '${seen.get(b.userId)}' and '${repo.id}'`,
				);
			} else {
				seen.set(b.userId, repo.id);
				botUserIds.push(b.userId);
			}
		}
	}
	return { ok: errors.length === 0, errors, botUserIds };
}

const BUILDER_ID = "3322520e-b959-4cbd-8b7c-929b05e445da";
const DESIGNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const builderBot: PlaneBotConfig = {
	role: "builder",
	userId: BUILDER_ID,
	token: "plane_api_builder",
	systemPrompt: "You are @builder.",
};

const designerBot: PlaneBotConfig = {
	role: "designer",
	userId: DESIGNER_ID,
	token: "plane_api_designer",
	systemPrompt: "You are @designer.",
};

describe("resolveBotForAssignees", () => {
	it("returns undefined when no planeBots configured", () => {
		const r = resolveBotForAssignees([BUILDER_ID], undefined);
		expect(r.bot).toBeUndefined();
		expect(r.multiple).toBe(false);
	});

	it("returns undefined when no assignee matches any bot", () => {
		const r = resolveBotForAssignees(["other-user"], [builderBot, designerBot]);
		expect(r.bot).toBeUndefined();
		expect(r.multiple).toBe(false);
	});

	it("returns the matched bot when exactly one is in assignees", () => {
		const r = resolveBotForAssignees([DESIGNER_ID], [builderBot, designerBot]);
		expect(r.bot?.role).toBe("designer");
		expect(r.multiple).toBe(false);
	});

	it("returns the first matching bot (and multiple=true) when both are assigned", () => {
		const r = resolveBotForAssignees(
			[BUILDER_ID, DESIGNER_ID],
			[builderBot, designerBot],
		);
		expect(r.bot?.role).toBe("builder"); // first in planeBots[] wins
		expect(r.multiple).toBe(true);
	});

	it("planeBots order = priority (designer first wins over builder)", () => {
		const r = resolveBotForAssignees(
			[BUILDER_ID, DESIGNER_ID],
			[designerBot, builderBot],
		);
		expect(r.bot?.role).toBe("designer");
		expect(r.multiple).toBe(true);
	});
});

describe("validatePlaneRepos", () => {
	it("ok for a single Plane repo with one bot", () => {
		const r = validatePlaneRepos([
			{
				id: "panfleet",
				planeProjectId: "35502ab9-d5b6-4397-9917-732a69eb9dd4",
				planeBots: [builderBot],
			},
		]);
		expect(r.ok).toBe(true);
		expect(r.errors).toEqual([]);
		expect(r.botUserIds).toEqual([BUILDER_ID]);
	});

	it("ok for a single Plane repo with two bots", () => {
		const r = validatePlaneRepos([
			{
				id: "panfleet",
				planeProjectId: "35502ab9-d5b6-4397-9917-732a69eb9dd4",
				planeBots: [builderBot, designerBot],
			},
		]);
		expect(r.ok).toBe(true);
		expect(r.botUserIds).toEqual([BUILDER_ID, DESIGNER_ID]);
	});

	it("rejects a Plane repo without planeBots[]", () => {
		const r = validatePlaneRepos([
			{
				id: "panfleet",
				planeProjectId: "35502ab9-d5b6-4397-9917-732a69eb9dd4",
			},
		]);
		expect(r.ok).toBe(false);
		expect(r.errors[0]).toMatch(/has planeProjectId but no planeBots/);
	});

	it("rejects two Plane repos sharing a bot userId", () => {
		const r = validatePlaneRepos([
			{
				id: "panfleet",
				planeProjectId: "35502ab9-d5b6-4397-9917-732a69eb9dd4",
				planeBots: [builderBot],
			},
			{
				id: "otherapp",
				planeProjectId: "11111111-1111-4111-8111-111111111111",
				planeBots: [builderBot],
			},
		]);
		expect(r.ok).toBe(false);
		expect(r.errors[0]).toMatch(/configured in both 'panfleet' and 'otherapp'/);
	});

	it("ignores non-Plane repos (no planeProjectId)", () => {
		const r = validatePlaneRepos([
			{
				id: "linear-only",
				// no planeProjectId
			},
			{
				id: "panfleet",
				planeProjectId: "35502ab9-d5b6-4397-9917-732a69eb9dd4",
				planeBots: [builderBot],
			},
		]);
		expect(r.ok).toBe(true);
		expect(r.botUserIds).toEqual([BUILDER_ID]);
	});
});
