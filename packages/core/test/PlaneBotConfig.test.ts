import { describe, expect, it } from "vitest";
import {
	PlaneBotConfigSchema,
	RepositoryConfigSchema,
} from "../src/config-schemas.js";

const VALID_USER_ID = "3322520e-b959-4cbd-8b7c-929b05e445da";
const VALID_USER_ID_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const minimalBot = {
	role: "builder" as const,
	userId: VALID_USER_ID,
	token: "plane_api_abc123",
	systemPrompt: "You are @builder.",
};

const fullBot = {
	...minimalBot,
	allowedTools: ["Read", "mcp__plane__*"],
	disallowedTools: ["Edit", "Write"],
	mcpConfigPath: "/home/cyrus/.cyrus/mcp-configs/builder.json",
	maxTurns: 40,
	bypassPermissions: true,
};

describe("PlaneBotConfigSchema", () => {
	it("accepts a fully populated config", () => {
		const parsed = PlaneBotConfigSchema.parse(fullBot);
		expect(parsed).toEqual(fullBot);
	});

	it("accepts a minimal config (only required fields)", () => {
		const parsed = PlaneBotConfigSchema.parse(minimalBot);
		expect(parsed.role).toBe("builder");
		expect(parsed.userId).toBe(VALID_USER_ID);
		expect(parsed.allowedTools).toBeUndefined();
		expect(parsed.maxTurns).toBeUndefined();
	});

	it("accepts role=designer", () => {
		const parsed = PlaneBotConfigSchema.parse({
			...minimalBot,
			role: "designer",
		});
		expect(parsed.role).toBe("designer");
	});

	it("rejects unknown role", () => {
		expect(() =>
			PlaneBotConfigSchema.parse({ ...minimalBot, role: "wizard" }),
		).toThrow();
	});

	it("rejects non-UUID userId", () => {
		expect(() =>
			PlaneBotConfigSchema.parse({ ...minimalBot, userId: "not-a-uuid" }),
		).toThrow();
	});

	it("rejects empty token", () => {
		expect(() =>
			PlaneBotConfigSchema.parse({ ...minimalBot, token: "" }),
		).toThrow();
	});

	it("rejects empty systemPrompt", () => {
		expect(() =>
			PlaneBotConfigSchema.parse({ ...minimalBot, systemPrompt: "" }),
		).toThrow();
	});

	it("rejects maxTurns <= 0", () => {
		expect(() =>
			PlaneBotConfigSchema.parse({ ...minimalBot, maxTurns: 0 }),
		).toThrow();
		expect(() =>
			PlaneBotConfigSchema.parse({ ...minimalBot, maxTurns: -1 }),
		).toThrow();
	});
});

describe("RepositoryConfigSchema with planeBots[]", () => {
	const baseRepo = {
		id: "panfleet",
		name: "Panfleet",
		repositoryPath: "/opt/Panfleet",
		baseBranch: "main",
		workspaceBaseDir: "/opt/Panfleet/worktrees",
	};

	it("accepts a repo with one bot", () => {
		const parsed = RepositoryConfigSchema.parse({
			...baseRepo,
			planeProjectId: "35502ab9-d5b6-4397-9917-732a69eb9dd4",
			planeBots: [minimalBot],
		});
		expect(parsed.planeBots).toHaveLength(1);
		expect(parsed.planeBots?.[0]?.role).toBe("builder");
	});

	it("accepts a repo with two bots of different roles", () => {
		const parsed = RepositoryConfigSchema.parse({
			...baseRepo,
			planeProjectId: "35502ab9-d5b6-4397-9917-732a69eb9dd4",
			planeBots: [
				minimalBot,
				{ ...minimalBot, role: "designer", userId: VALID_USER_ID_2 },
			],
		});
		expect(parsed.planeBots).toHaveLength(2);
	});

	it("rejects duplicate bot userIds within the same repo", () => {
		expect(() =>
			RepositoryConfigSchema.parse({
				...baseRepo,
				planeProjectId: "35502ab9-d5b6-4397-9917-732a69eb9dd4",
				planeBots: [minimalBot, { ...minimalBot, role: "designer" }],
			}),
		).toThrow();
	});

	it("accepts a repo without planeBots (Linear-only)", () => {
		const parsed = RepositoryConfigSchema.parse(baseRepo);
		expect(parsed.planeBots).toBeUndefined();
	});
});
