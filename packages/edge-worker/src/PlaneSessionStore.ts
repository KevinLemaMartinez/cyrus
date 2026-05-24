/**
 * Persists the last Claude session id observed for each Plane issue id,
 * so subsequent comments on that issue can resume the conversation via
 * ClaudeRunner.startStreaming(prompt, { resumeSessionId }).
 *
 * Behaviour parallel to Linear's PersistenceManager — keep the same
 * cross-restart guarantee without coupling to AgentSessionManager /
 * CyrusAgentSession (which are Linear-specific).
 *
 * Store layout: a single JSON file (default ~/.cyrus/plane-sessions.json)
 * mapping issueId → entry. Writes are serialised through an internal
 * promise chain and applied via writeFile(tmp) + rename(tmp, final) for
 * atomicity.
 */
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createLogger, type ILogger } from "cyrus-core";

export interface PlaneStoredSession {
	claudeSessionId: string;
	projectId: string;
	workspaceSlug: string;
	updatedAt: number;
}

export interface PlaneSessionStoreConfig {
	storePath: string;
	logger?: ILogger;
	/** Override default 30-day TTL (ms). Visible for tests. */
	maxAgeMs?: number;
}

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export class PlaneSessionStore {
	private readonly storePath: string;
	private readonly logger: ILogger;
	private readonly maxAgeMs: number;
	private readonly entries = new Map<string, PlaneStoredSession>();
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(config: PlaneSessionStoreConfig) {
		this.storePath = config.storePath;
		this.logger =
			config.logger ?? createLogger({ component: "PlaneSessionStore" });
		this.maxAgeMs = config.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	}

	async load(): Promise<void> {
		try {
			const raw = await readFile(this.storePath, "utf8");
			const parsed = JSON.parse(raw) as Record<string, PlaneStoredSession>;
			this.entries.clear();
			for (const [issueId, entry] of Object.entries(parsed)) {
				if (this.isValidEntry(entry)) {
					this.entries.set(issueId, entry);
				}
			}
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				this.logger.debug(
					`PlaneSessionStore: ${this.storePath} not found, starting empty`,
				);
				return;
			}
			this.logger.error(
				`PlaneSessionStore: failed to load ${this.storePath}, starting empty: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	get(issueId: string): PlaneStoredSession | undefined {
		return this.entries.get(issueId);
	}

	async set(issueId: string, entry: PlaneStoredSession): Promise<void> {
		this.entries.set(issueId, entry);
		this.purgeStale();
		await this.enqueueWrite();
	}

	async delete(issueId: string): Promise<void> {
		this.entries.delete(issueId);
		await this.enqueueWrite();
	}

	private isValidEntry(e: unknown): e is PlaneStoredSession {
		if (typeof e !== "object" || e === null) return false;
		const x = e as Partial<PlaneStoredSession>;
		return (
			typeof x.claudeSessionId === "string" &&
			typeof x.projectId === "string" &&
			typeof x.workspaceSlug === "string" &&
			typeof x.updatedAt === "number"
		);
	}

	private purgeStale(): void {
		const cutoff = Date.now() - this.maxAgeMs;
		for (const [k, v] of this.entries) {
			if (v.updatedAt < cutoff) {
				this.entries.delete(k);
			}
		}
	}

	private enqueueWrite(): Promise<void> {
		this.writeQueue = this.writeQueue.then(() => this.writeNow());
		return this.writeQueue;
	}

	private async writeNow(): Promise<void> {
		const serialisable = Object.fromEntries(this.entries);
		const json = JSON.stringify(serialisable, null, 2);
		const tmp = `${this.storePath}.tmp`;
		try {
			await writeFile(tmp, json, "utf8");
			await rename(tmp, this.storePath);
		} catch (err) {
			this.logger.error(
				`PlaneSessionStore: failed to persist ${this.storePath}: ${err instanceof Error ? err.message : String(err)}`,
			);
			try {
				await unlink(tmp);
			} catch {
				// ignore
			}
			throw err;
		}
	}
}
