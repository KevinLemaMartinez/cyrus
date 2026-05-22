# H5 — Wire `cyrus-plane-event-transport` into EdgeWorker

**Status:** Spec ready for implementation.
**Date:** 2026-05-23.
**Author:** brainstorming session with Claude.
**Branch:** `feat/plane-event-transport`.
**Related memory:** `cyrus-plane-fork.md`.

## Goal

Plug the existing `cyrus-plane-event-transport` package into the `EdgeWorker`
so that an assignment of a Plane CE issue to the `@builder` bot user runs
end-to-end: webhook → worktree → ClaudeRunner → comments streamed back into the
Plane issue.

H5 in the original plan was "add Plane to the `AgentEventTransportConfig`
discriminated union". On re-evaluation we picked a **dedicated minimal pipeline**
instead — no changes to `cyrus-core`'s discriminated union, no full
`IIssueTrackerService` implementation. Plane runs in its own lane next to
Linear, the same way GitHub does today.

## Non-goals

- Multi-turn handling of follow-up Plane comments on the same issue.
- Mapping Plane events into Linear's `AgentEvent` shape.
- A full `IIssueTrackerService` implementation for Plane.
- Plane Agent Session emulation (we treat the issue itself as the session).
- Refactoring `EdgeWorker.handleWebhook` to be platform-agnostic.
- Sentry / Prometheus instrumentation.
- Concurrency dedupe per `issue.id` (only per `delivery` UUID).

## Decisions taken during brainstorming

| Question | Decision |
|---|---|
| Integration depth | Real integration with ClaudeRunner (skip "smoke only"). |
| Pipeline fidelity | Dedicated Plane pipeline, minimal. Does **not** route through Linear's `handleWebhook` / `handleMessage`. |
| Config location | Env vars (`PLANE_BASE_URL`, `PLANE_WORKSPACE_SLUG`, `PLANE_BOT_USER_ID`, `PLANE_BOT_TOKEN`, `PLANE_WEBHOOK_SECRET`). |
| Repo routing | New `planeProjectId?: string` optional field on `RepositoryConfig`. |
| Comment shape | Streaming activities — per `SDKMessage`, with separate comments for assistant text and tool use / tool result. |
| Dedupe | In-memory `Set<string>` keyed on `x-plane-delivery` UUID, bounded FIFO at 1000 entries. |

## Architecture

```
Plane webhook  ─►  Fastify (/plane-webhook)         [SharedApplicationServer]
                          │
                          ▼
                  PlaneEventTransport             (verifies HMAC + dedupe)
                          │  emit("event", PlaneAgentEvent)
                          ▼
                  EdgeWorker.handlePlaneEvent()
                          │
            ┌─────────────┴─────────────┐
            ▼                           ▼
   "issue.assigned_to_bot"     "comment.created_on_bot_issue"
            │                           │
            ▼                           ▼
   resolve repo by                  log + ignore (POC)
   planeProjectId
            │
            ├── ningún match ──► log warn + drop
            └── match
                  │
                  ▼
   PlaneSessionRunner.handleAssignment(event, repo)
            │
            ▼
   - acknowledge comment in Plane
   - MinimalIssue shim (from event.issue)
   - GitService.createGitWorktree(shim, [repo])
   - new ClaudeRunner({ workingDirectory, cyrusHome, ... })
   - PlaneClaudeActivityPoster listens on runner.on("message", ...)
     → posts comments per assistant message / tool use / tool result
   - runner.on("complete") → final "✅ Sesión completada" comment
```

Plane's transport is **gated by env vars** — when not configured, the
`/plane-webhook` endpoint is not mounted at all. This matches how GitHub /
GitLab / Slack work today.

## Files touched

### New

| Path | Purpose |
|---|---|
| `packages/edge-worker/src/PlaneSessionRunner.ts` | Encapsulates the Plane pipeline (worktree + ClaudeRunner + activity wiring). Lives in `edge-worker` to honor the `edge-worker → plane-event-transport` dependency direction. |
| `packages/edge-worker/src/PlaneClaudeActivityPoster.ts` | Translates `SDKMessage` events to Plane HTML comments and posts them sequentially via a chained `Promise<void>` queue. |
| `packages/edge-worker/test/PlaneSessionRunner.test.ts` | Unit tests for the runner (happy path, worktree failure, MinimalIssue shape). |
| `packages/edge-worker/test/PlaneClaudeActivityPoster.test.ts` | Unit tests for the poster (per-message-type formatting, ordering, error tolerance). |

### Modified

| Path | Change |
|---|---|
| `packages/core/src/config-schemas.ts` | Add `planeProjectId: z.string().uuid().optional()` to the `RepositoryConfig` schema. |
| `packages/core/src/config-types.ts` | Add `planeProjectId?: string` to the `RepositoryConfig` type. |
| `packages/edge-worker/src/EdgeWorker.ts` | Add `planeEventTransport`, `planeIssueTracker`, `planeSessionRunner`, `planeDeliveryDedupe` fields. Add `registerPlaneEventTransport()` (called from `initializeComponents`) and `handlePlaneEvent()` dispatcher. |
| `packages/edge-worker/package.json` | Add `"cyrus-plane-event-transport": "workspace:*"` to deps. |
| `packages/plane-event-transport/src/PlaneEventTransport.ts` | Refactor `register(server)` → `register()`. Move `FastifyInstance` to `PlaneEventTransportConfig.fastifyServer`. Aligns with `LinearEventTransport` / `GitHubEventTransport`. |
| `packages/plane-event-transport/src/types.ts` | Add `fastifyServer: FastifyInstance` to `PlaneEventTransportConfig`. |
| `packages/plane-event-transport/scripts/dev-runner.ts` | Adapt to new constructor signature. |

### Not touched

- `packages/core/src/issue-tracker/IAgentEventTransport.ts` — Plane stays out of the discriminated union.
- `packages/core/src/issue-tracker/IIssueTrackerService.ts` — Plane stays a free-standing service.
- `packages/edge-worker/src/ConfigManager.ts` — `planeProjectId` is per-repo, not top-level, so the hardcoded merge whitelist in `loadConfigSafely()` does not apply (this **must** be verified during implementation; see "Risks").

## Data flow

### Bootstrap (EdgeWorker startup)

1. `initializeComponents()` → `registerPlaneEventTransport()` after the GitHub / GitLab / Slack registrations.
2. The method reads `PLANE_BASE_URL`, `PLANE_WORKSPACE_SLUG`, `PLANE_BOT_USER_ID`, `PLANE_BOT_TOKEN`, `PLANE_WEBHOOK_SECRET`.
   - If any var is missing → log `info("Plane transport not configured, skipping")` and return.
   - If all present → instantiate `PlaneIssueTrackerService`, instantiate `PlaneEventTransport` with `verificationMode: "direct"` and the Fastify server from `sharedApplicationServer.getFastifyInstance()`, then `transport.register()`.
3. Wire the listener: `transport.on("event", e => this.handlePlaneEvent(e))`.
4. Instantiate `PlaneSessionRunner({ gitService, planeIssueTracker, claudeRunnerFactory, cyrusHome, logger })`.

### Inbound webhook

1. Plane POSTs `/plane-webhook` with headers `x-plane-signature`, `x-plane-delivery`, JSON body.
2. `PlaneEventTransport`:
   - Reads `request.rawBody`, verifies HMAC. If invalid → reply `401`.
   - Looks up the `delivery` UUID in the in-memory `Set<string>`. If already seen → reply `200 { dedup: true }` and stop.
   - If new → push to the `Set`; if `Set.size > 1000` evict the first inserted (FIFO).
   - Calls `translatePayload(envelope)`. If `null` → reply `200 { ignored: true }`.
   - Else `emit("event", agentEvent)` and reply `200 { ok: true }`.
3. `EdgeWorker.handlePlaneEvent(event)` dispatches by `event.type`:
   - `"comment.created_on_bot_issue"` → log info "POC: comment handling not implemented" and return.
   - `"issue.assigned_to_bot"`:
     - Find `repo = [...this.repositories.values()].find(r => r.planeProjectId === event.projectId)`.
     - If no match → log warn and drop.
     - If match → call `this.planeSessionRunner.handleAssignment(event, repo)` **without awaiting**. Errors are caught inside the runner.

### `PlaneSessionRunner.handleAssignment(event, repo)`

1. **Acknowledge comment** — `await planeIssueTracker.createComment(event.issue.id, event.projectId, "<p>👋 Recibí la asignación, arrancando…</p>")`. On failure log and return.
2. **MinimalIssue shim** — construct an object structurally compatible with the slice of `cyrus-core` `Issue` that `GitService.createGitWorktree` reads:
   ```ts
   {
     id: planeIssue.id,
     identifier: `PFL-${planeIssue.sequence_id}`,
     title: planeIssue.name,
     description: stripHtml(planeIssue.description_html ?? ""),
     branchName: sanitize(`plane-${sequence_id}-${slug(name)}`),
     labels: async () => emptyConnection(),
     inverseRelations: async () => emptyConnection(),
     parent: undefined,
     // any other accessor invoked by GitService.determineBaseBranch
     // resolves to undefined / empty so it falls through to the default
     // base branch.
   } as unknown as Issue
   ```
   The cast is justified by the empirical surface used by `GitService` (see `GitService.ts:201-453`). `determineBaseBranch` falls through to the default repo base branch when graphite/parent/labels return empty.
3. **Worktree** — `const workspace = await gitService.createGitWorktree(minimalIssue, [repo])`.
4. **ClaudeRunner** — instantiate with:
   - `workingDirectory: workspace.path`
   - `cyrusHome` (passed from EdgeWorker)
   - `model`: same source used today by the Linear path (`RepositoryConfig.claudeModel` if set, else the global `claudeDefaultModel`)
   - `allowedTools` / `disallowedTools`: the repo's resolved Linear-path defaults — we deliberately reuse the existing resolver instead of inventing a Plane-specific one for POC
   - `systemPrompt`: minimal POC prompt — `Sos @builder. Estás trabajando en el issue "<title>". Descripción: <description>. Implementá lo pedido, commiteá y abrí un PR a origin/main.`
   - Listeners — `runner.on("message", m => poster.handleMessage(m))`, `runner.on("error", e => poster.handleError(e))`, `runner.on("complete", () => poster.handleComplete())`.
5. **Run** — `await claudeRunner.start("")` (the work is described in the system prompt; `start()` runs single-shot, no streaming input).
6. **Cleanup** — worktree is left on disk; no automated cleanup in POC.

### `PlaneClaudeActivityPoster`

Listens **only** on `runner.on("message", ...)` to avoid double-posting (since `text`, `tool-use`, `assistant`, `end-turn` are all derivative of `message`).

Switch on `SDKMessage.type`:

| Type | Block | Plane HTML comment |
|---|---|---|
| `assistant` | text block | `<p>{text}</p>` |
| `assistant` | `tool_use` block | `<p>🔧 <code>{toolName}</code></p><pre>{JSON.stringify(input, null, 2).slice(0, 2000)}</pre>` |
| `user` | `tool_result` block (success) | `<p>📤 <code>{toolName}</code> → ✅</p>` + optional short preview |
| `user` | `tool_result` block (error) | `<p>📤 <code>{toolName}</code> → ❌</p>` + truncated error text |
| `result` (`SDKResultMessage`) | n/a | `<p>✅ Sesión completada</p><p>{lastAssistantText}</p>` |
| `system` | n/a | ignored |

Each call to `createComment` is appended to a chained `Promise<void>` queue so
the posts hit Plane **in order** even when several `message` events fire
rapidly. Posting failures are logged but do not abort the chain.

`handleError(e)` posts `<p>❌ Error de Claude: {message}</p>` through the same
queue. `handleComplete()` flushes by enqueuing the `result`-derived final
comment.

## Concurrency model

- Different issues → independent worktrees, runners, posters. They run in
  parallel safely.
- Same `delivery` UUID arriving twice → blocked by the `Set<string>` dedupe.
- Same `issue.id` with **different** delivery UUIDs (user unassigns and
  reassigns) → POC spawns a second concurrent runner. **Documented limitation.**
  Not a footgun for the demo because the user controls the assignment timing.

## Error handling

| Failure point | Behavior |
|---|---|
| HMAC invalid | `401` from transport. No event emitted. |
| Delivery duplicate | `200 { dedup: true }`. No event emitted. |
| `event.projectId` has no repo match | Log warn, drop event. |
| `createComment` (acknowledge) | Log error, return (rest of pipeline aborted). |
| `createGitWorktree` | Catch in `handleAssignment`. Post `<p>❌ No pude crear el workspace: {error.message}</p>` and stop. |
| `ClaudeRunner` `error` event | Poster posts `<p>❌ Error de Claude: {message}</p>`. Runner may still emit `complete`. |
| `createComment` (activity / final) | Log error, continue chain. No retries. |

## Logging

- New loggers: `createLogger({ component: "PlaneEventTransport" })` and
  `createLogger({ component: "PlaneSessionRunner" })`.
- Each pipeline step logs `issueId`, `projectId`, `deliveryId` for
  correlation.
- Counters via log lines (no Prometheus / Sentry in POC): event received,
  comment posted, error.

## Testing

### Unit tests (vitest)

1. `PlaneClaudeActivityPoster.test.ts` — 4-6 cases:
   - Text-only `SDKAssistantMessage` → one `createComment` call with `<p>{text}</p>`.
   - `tool_use` block → one call with the tool-use HTML format.
   - `tool_result` (success and error) → two cases, correct icon.
   - Final `SDKResultMessage` → final comment posted.
   - Ordering: mock `createComment` resolves out of order; assert call order matches event order.
   - `createComment` rejects on one call → next call still happens.

2. `PlaneSessionRunner.test.ts` — 3 cases:
   - Happy path with mocked `gitService`, `planeIssueTracker`,
     `claudeRunnerFactory`. Assert acknowledge comment posted,
     `createGitWorktree` called with the MinimalIssue, ClaudeRunner
     constructed with the right `workingDirectory`.
   - `createGitWorktree` rejects → error comment posted, ClaudeRunner not
     constructed.
   - MinimalIssue shim: assert `identifier`, `branchName`, `title` derived
     from a `PlaneIssue` fixture.

3. `EdgeWorker.handlePlaneEvent` — one targeted unit test with an EdgeWorker
   built around an empty `repositories` Map: assert warning is logged and
   the session runner is not invoked.

### Existing tests touched

- The Fastify `register()` refactor in `PlaneEventTransport` will break any
  test that instantiates it the old way. Migrate during implementation.
  `plane-webhook-utils.test.ts` is unaffected (pure utility tests).

### Smoke (manual)

Documented in `packages/plane-event-transport/README.md`:

1. Configure a webhook in Plane CE pointing at the running EdgeWorker plus the shared secret.
2. Add a repository to `~/.cyrus/config.json` with `planeProjectId: "<Panfleet UUID>"`.
3. Set the `PLANE_*` env vars.
4. Start `cyrus`.
5. Create a Plane issue in Panfleet and assign it to the bot.
6. Expected timeline of comments on the Plane issue:
   - Acknowledge comment (immediate).
   - One comment per assistant message / tool use / tool result while Claude works.
   - Final `✅ Sesión completada` comment when the run ends.
7. Worktree exists at `<workspaceBaseDir>/PFL-<seq>/`. Branch is checked out
   inside. PR is opened (or attempted) on the repo.

## Risks and open questions

- **`planeProjectId` in `RepositoryConfig`** — the per-repo merge in
  `ConfigManager.loadConfigSafely()` needs to be verified during
  implementation. If it does whitelist per-repo fields the way it does
  top-level fields, we'll add `planeProjectId` to that whitelist too.
- **Empirical `Issue` surface for `GitService.createGitWorktree`** — the
  MinimalIssue shim is built on a visual scan of `GitService.ts`. If a code
  path inside `GitService` calls something else on `issue` (e.g.
  `issue.team`), the call will throw at runtime. The unit test "happy path"
  must drive a real `createGitWorktree` call against a temp git repo to
  surface this.
- **`SharedApplicationServer` raw body preservation** — Linear/GitHub already
  depend on `request.rawBody` for HMAC verification. We are assuming the
  content-type parser in that file is shared and already preserves it. If
  not, we'll have to add it there (and that change affects Linear/GitHub
  too — handle carefully).
- **`identifier` collision** — synthetic `PFL-<seq>` follows Plane's natural
  ordering inside a project, but two different Plane projects can have
  overlapping `sequence_id` numbers. Documented limitation — for POC with a
  single project (Panfleet) it does not matter; for multi-project we will
  need to prefix with a project identifier.

## What the user will need to do

1. Add `planeProjectId: "35502ab9-d5b6-4397-9917-732a69eb9dd4"` (Panfleet
   UUID) to the relevant repository in `~/.cyrus/config.json`.
2. Set `PLANE_*` env vars (already documented for the dev-runner) on the
   EdgeWorker process.
3. Configure the webhook in Plane CE to point at the EdgeWorker's
   `/plane-webhook` endpoint with the secret matching
   `PLANE_WEBHOOK_SECRET`.
4. Create a GitHub App `ai-agent-bot` and install it in the Panfleet repo
   so Cyrus can open PRs (already tracked in the project memory as
   pending).

## Next steps

After this spec is approved, the next step is the `writing-plans` skill to
produce an implementation plan.
