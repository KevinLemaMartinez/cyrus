import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PlaneApiError,
	PlaneIssueTrackerService,
} from "../src/PlaneIssueTrackerService.js";
import type { PlaneEventTransportConfig } from "../src/types.js";

const CONFIG: PlaneEventTransportConfig = {
	secret: "wh-secret",
	verificationMode: "direct",
	workspaceSlug: "panfleet",
	baseUrl: "https://plane.pulp.lan/",
	apiToken: "plane_api_test",
	botUserIds: ["3322520e-b959-4cbd-8b7c-929b05e445da"],
};

const BOT_USER_ID = CONFIG.botUserIds[0];

const PROJ = "35502ab9-d5b6-4397-9917-732a69eb9dd4";
const ISSUE = "a0f19eec-e6fd-414b-b5a0-57f14e13f043";

function mockFetch() {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const responses: Array<{ ok: boolean; status: number; body: string }> = [];

	const impl = vi.fn(async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		const r = responses.shift() ?? { ok: true, status: 200, body: "{}" };
		return {
			ok: r.ok,
			status: r.status,
			text: async () => r.body,
		} as unknown as Response;
	});
	vi.stubGlobal("fetch", impl);
	return {
		calls,
		respondWith(resp: { ok: boolean; status: number; body: string }) {
			responses.push(resp);
		},
	};
}

describe("PlaneIssueTrackerService", () => {
	let m: ReturnType<typeof mockFetch>;
	let svc: PlaneIssueTrackerService;

	beforeEach(() => {
		m = mockFetch();
		svc = new PlaneIssueTrackerService(CONFIG);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("getPlatformType / getPlatformMetadata return plane / community", () => {
		expect(svc.getPlatformType()).toBe("plane");
		expect(svc.getPlatformMetadata()).toEqual({
			baseUrl: "https://plane.pulp.lan",
			workspace: "panfleet",
			edition: "community",
		});
	});

	it("fetchCurrentUser hits the workspace-agnostic /users/me/ endpoint", async () => {
		m.respondWith({
			ok: true,
			status: 200,
			body: JSON.stringify({
				id: BOT_USER_ID,
				email: "builder@bot.pulp.lan",
				first_name: "",
				last_name: "",
				display_name: "builder",
				avatar: "",
				avatar_url: null,
			}),
		});
		const user = await svc.fetchCurrentUser();
		expect(user.email).toBe("builder@bot.pulp.lan");
		expect(m.calls[0].url).toBe("https://plane.pulp.lan/api/v1/users/me/");
		expect(
			(m.calls[0].init.headers as Record<string, string>)["X-API-Key"],
		).toBe("plane_api_test");
	});

	it("fetchIssue requires UUIDs and uses project-scoped path", async () => {
		m.respondWith({
			ok: true,
			status: 200,
			body: JSON.stringify({ id: ISSUE, name: "x" }),
		});
		await svc.fetchIssue(ISSUE, PROJ);
		expect(m.calls[0].url).toBe(
			`https://plane.pulp.lan/api/v1/workspaces/panfleet/projects/${PROJ}/issues/${ISSUE}/`,
		);
		expect(m.calls[0].init.method).toBe("GET");
	});

	it("fetchIssue rejects non-UUID inputs", async () => {
		await expect(svc.fetchIssue("PFL-1", PROJ)).rejects.toThrow(/UUID/);
	});

	it("createIssue POSTs to project issues collection", async () => {
		m.respondWith({
			ok: true,
			status: 201,
			body: JSON.stringify({ id: "new", name: "hello" }),
		});
		await svc.createIssue(PROJ, {
			name: "hello",
			description_html: "<p>body</p>",
			priority: "medium",
		});
		expect(m.calls[0].url).toBe(
			`https://plane.pulp.lan/api/v1/workspaces/panfleet/projects/${PROJ}/issues/`,
		);
		expect(m.calls[0].init.method).toBe("POST");
		expect(JSON.parse(m.calls[0].init.body as string)).toEqual({
			name: "hello",
			description_html: "<p>body</p>",
			priority: "medium",
		});
	});

	it("updateIssue PATCHes the project-scoped issue path", async () => {
		m.respondWith({
			ok: true,
			status: 200,
			body: JSON.stringify({ id: ISSUE }),
		});
		await svc.updateIssue(ISSUE, PROJ, { priority: "high" });
		expect(m.calls[0].url).toBe(
			`https://plane.pulp.lan/api/v1/workspaces/panfleet/projects/${PROJ}/issues/${ISSUE}/`,
		);
		expect(m.calls[0].init.method).toBe("PATCH");
		expect(JSON.parse(m.calls[0].init.body as string)).toEqual({
			priority: "high",
		});
	});

	it("createComment POSTs with comment_html field", async () => {
		m.respondWith({
			ok: true,
			status: 201,
			body: JSON.stringify({ id: "c-1" }),
		});
		await svc.createComment(ISSUE, PROJ, "<p>hi</p>");
		expect(m.calls[0].url).toBe(
			`https://plane.pulp.lan/api/v1/workspaces/panfleet/projects/${PROJ}/issues/${ISSUE}/comments/`,
		);
		expect(JSON.parse(m.calls[0].init.body as string)).toEqual({
			comment_html: "<p>hi</p>",
		});
	});

	it("wraps non-2xx responses in PlaneApiError with status + body", async () => {
		m.respondWith({ ok: false, status: 403, body: '{"error":"nope"}' });
		const promise = svc.fetchIssue(ISSUE, PROJ);
		await expect(promise).rejects.toBeInstanceOf(PlaneApiError);
		await expect(promise).rejects.toMatchObject({
			method: "GET",
			status: 403,
		});
	});

	it("stub methods throw 'Not implemented in POC'", () => {
		expect(() => svc.fetchTeams()).toThrow(/Not implemented in POC/);
		expect(() => svc.createAgentActivity()).toThrow(/Not implemented in POC/);
	});

	describe("tokenOverride", () => {
		it("createComment uses tokenOverride when provided", async () => {
			m.respondWith({
				ok: true,
				status: 201,
				body: JSON.stringify({ id: "c-1" }),
			});
			await svc.createComment(ISSUE, PROJ, "<p>by designer</p>", {
				tokenOverride: "plane_api_designer",
			});
			expect(
				(m.calls[0].init.headers as Record<string, string>)["X-API-Key"],
			).toBe("plane_api_designer");
		});

		it("createComment falls back to constructor token without override", async () => {
			m.respondWith({
				ok: true,
				status: 201,
				body: JSON.stringify({ id: "c-1" }),
			});
			await svc.createComment(ISSUE, PROJ, "<p>default</p>");
			expect(
				(m.calls[0].init.headers as Record<string, string>)["X-API-Key"],
			).toBe("plane_api_test");
		});

		it("fetchIssue accepts a tokenOverride", async () => {
			m.respondWith({
				ok: true,
				status: 200,
				body: JSON.stringify({ id: ISSUE }),
			});
			await svc.fetchIssue(ISSUE, PROJ, { tokenOverride: "plane_api_other" });
			expect(
				(m.calls[0].init.headers as Record<string, string>)["X-API-Key"],
			).toBe("plane_api_other");
		});
	});

	describe("constructor without apiToken", () => {
		it("instantiates with apiToken undefined", () => {
			const noTokenSvc = new PlaneIssueTrackerService({
				...CONFIG,
				apiToken: undefined as unknown as string,
			});
			expect(noTokenSvc.getPlatformType()).toBe("plane");
		});

		it("createComment without constructor token and without override throws clear error", async () => {
			const noTokenSvc = new PlaneIssueTrackerService({
				...CONFIG,
				apiToken: undefined as unknown as string,
			});
			await expect(
				noTokenSvc.createComment(ISSUE, PROJ, "<p>x</p>"),
			).rejects.toThrow(/token/i);
		});

		it("createComment without constructor token but WITH override succeeds", async () => {
			const noTokenSvc = new PlaneIssueTrackerService({
				...CONFIG,
				apiToken: undefined as unknown as string,
			});
			m.respondWith({
				ok: true,
				status: 201,
				body: JSON.stringify({ id: "c-1" }),
			});
			await noTokenSvc.createComment(ISSUE, PROJ, "<p>x</p>", {
				tokenOverride: "plane_api_per_call",
			});
			expect(
				(m.calls[0].init.headers as Record<string, string>)["X-API-Key"],
			).toBe("plane_api_per_call");
		});
	});
});
