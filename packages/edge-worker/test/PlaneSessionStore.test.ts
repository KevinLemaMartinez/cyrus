import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlaneSessionStore } from "../src/PlaneSessionStore.js";

describe("PlaneSessionStore", () => {
	let dir: string;
	let storePath: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "plane-session-store-"));
		storePath = join(dir, "plane-sessions.json");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("load() returns empty when the file does not exist", async () => {
		const store = new PlaneSessionStore({ storePath });
		await store.load();
		expect(store.get("issue-1")).toBeUndefined();
	});

	it("load() returns empty when the file is invalid JSON (no throw)", async () => {
		await writeFile(storePath, "{not json", "utf8");
		const store = new PlaneSessionStore({ storePath });
		await store.load();
		expect(store.get("issue-1")).toBeUndefined();
	});

	it("set() persists atomically; get() reads back the same value", async () => {
		const store = new PlaneSessionStore({ storePath });
		await store.load();
		await store.set("issue-1", {
			claudeSessionId: "claude-session-1",
			projectId: "proj-1",
			workspaceSlug: "panfleet",
			updatedAt: Date.now(),
		});
		expect(store.get("issue-1")?.claudeSessionId).toBe("claude-session-1");

		const onDisk = JSON.parse(await readFile(storePath, "utf8"));
		expect(onDisk["issue-1"].claudeSessionId).toBe("claude-session-1");
	});

	it("set() purges entries older than 30 days on each write", async () => {
		const store = new PlaneSessionStore({ storePath });
		await store.load();
		const oldUpdatedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
		await store.set("stale", {
			claudeSessionId: "old-session",
			projectId: "proj-1",
			workspaceSlug: "panfleet",
			updatedAt: oldUpdatedAt,
		});
		await store.set("fresh", {
			claudeSessionId: "new-session",
			projectId: "proj-1",
			workspaceSlug: "panfleet",
			updatedAt: Date.now(),
		});
		expect(store.get("stale")).toBeUndefined();
		expect(store.get("fresh")?.claudeSessionId).toBe("new-session");
	});

	it("delete() removes the entry and persists the deletion", async () => {
		const store = new PlaneSessionStore({ storePath });
		await store.load();
		await store.set("issue-1", {
			claudeSessionId: "s1",
			projectId: "p1",
			workspaceSlug: "panfleet",
			updatedAt: Date.now(),
		});
		await store.delete("issue-1");
		expect(store.get("issue-1")).toBeUndefined();

		const reload = new PlaneSessionStore({ storePath });
		await reload.load();
		expect(reload.get("issue-1")).toBeUndefined();
	});

	it("set() persists botUserId when provided and reads it back", async () => {
		const store = new PlaneSessionStore({ storePath });
		await store.load();
		await store.set("issue-1", {
			claudeSessionId: "s1",
			projectId: "p1",
			workspaceSlug: "panfleet",
			botUserId: "3322520e-b959-4cbd-8b7c-929b05e445da",
			updatedAt: Date.now(),
		});
		expect(store.get("issue-1")?.botUserId).toBe(
			"3322520e-b959-4cbd-8b7c-929b05e445da",
		);

		const reload = new PlaneSessionStore({ storePath });
		await reload.load();
		expect(reload.get("issue-1")?.botUserId).toBe(
			"3322520e-b959-4cbd-8b7c-929b05e445da",
		);
	});

	it("load() tolerates legacy entries without botUserId (treats as undefined)", async () => {
		const legacy = {
			"issue-old": {
				claudeSessionId: "claude-pre-bots",
				projectId: "p1",
				workspaceSlug: "panfleet",
				updatedAt: Date.now(),
			},
		};
		await writeFile(storePath, JSON.stringify(legacy), "utf8");
		const store = new PlaneSessionStore({ storePath });
		await store.load();
		const entry = store.get("issue-old");
		expect(entry?.claudeSessionId).toBe("claude-pre-bots");
		expect(entry?.botUserId).toBeUndefined();
	});

	it("serialises concurrent set() calls without losing data", async () => {
		const store = new PlaneSessionStore({ storePath });
		await store.load();
		const now = Date.now();
		await Promise.all([
			store.set("a", {
				claudeSessionId: "sa",
				projectId: "p",
				workspaceSlug: "w",
				updatedAt: now,
			}),
			store.set("b", {
				claudeSessionId: "sb",
				projectId: "p",
				workspaceSlug: "w",
				updatedAt: now,
			}),
			store.set("c", {
				claudeSessionId: "sc",
				projectId: "p",
				workspaceSlug: "w",
				updatedAt: now,
			}),
		]);
		const onDisk = JSON.parse(await readFile(storePath, "utf8"));
		expect(Object.keys(onDisk).sort()).toEqual(["a", "b", "c"]);
	});
});
