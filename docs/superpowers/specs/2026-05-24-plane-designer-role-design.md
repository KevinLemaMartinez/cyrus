# Plane multi-bot roles — adding `@designer` alongside `@builder`

**Date**: 2026-05-24
**Status**: draft (awaiting implementation)
**Owner**: kevin
**Related**: [[2026-05-23-h5-plane-edge-worker-design]], [[2026-05-24-plane-hardening-design]]

## Goal

Extend the Plane CE pipeline so that multiple bots — each with its own Plane user, system prompt, allowed tools, and MCP servers — can coexist on the same Cyrus instance. The first concrete second role is `@designer`, focused on Figma + Plane commentary work (no code edits, no PR).

## Why

The current pipeline supports a single bot identity (`@builder`) wired via env vars (`PLANE_BOT_USER_ID`, `PLANE_BOT_TOKEN`) and a hardcoded system prompt inside `PlaneSessionRunner`. With Figma MCP now working end-to-end (PFL-15) we can usefully separate concerns by role:

- `@builder` keeps doing code → PR workflows.
- `@designer` operates on Figma files and posts visual proposals as Plane comments, with code-editing tools denied.

Both roles must run on the **same** LXC, same `cyrus.service`, same `/plane-webhook` endpoint, distinguishable only by which bot is in the issue's `assignees`.

## Scope

**In scope**:

- New `RepositoryConfig.planeBots[]` schema carrying per-bot config (userId, token, systemPrompt, allowed/disallowedTools, mcpConfigPath, maxTurns, bypassPermissions).
- Bot resolution from Plane webhook payloads (`issue.assigned_to_bot` and `comment.created_on_bot_issue`).
- Per-bot token override on `PlaneIssueTrackerService.createComment` so comments authored by the right bot.
- `PlaneSessionStore` entry extended with `botUserId` so resume picks the correct config.
- Removal of `PLANE_BOT_USER_ID` / `PLANE_BOT_TOKEN` env vars; warn-only on legacy usage.
- Concrete `@designer` system prompt and tool list shipped as the seed second role.

**Out of scope**:

- Per-rol session runner subclasses (current `PlaneSessionRunner` handles both via data).
- Per-bot worktree skipping (designer reuses the existing worktree pipeline).
- Multi-workspace / multi-instance Plane (one `PLANE_BASE_URL` + `PLANE_WORKSPACE_SLUG` + `PLANE_WEBHOOK_SECRET` still applies globally).
- New role types beyond `builder` and `designer` (extending the enum is a 1-line change later).
- Admin endpoint to stop individual bots.

## Architecture

**Single webhook, single transport, single runner instance — bots are data.**

```
Plane webhook
    ↓ HMAC verify, dedupe
PlaneEventTransport.translatePayload(payload, botUserIds=[...])
    ↓ emit PlaneAgentEvent (no bot resolved yet)
EdgeWorker.handlePlaneEvent
    ↓ resolve repo by planeProjectId
    ↓ resolve bot by matching event.issue.assignees ∩ repo.planeBots[].userId
PlaneSessionRunner.handleAssignment(event, repo, bot)
    ↓ uses bot.systemPrompt, bot.allowedTools, bot.mcpConfigPath, bot.token, ...
ClaudeRunner spawn (same process model as today)
```

Same shape for `handleComment`, with the addition that `PlaneSessionStore` records `botUserId` and the comment branch cross-checks resolved-bot vs stored-bot to decide resume vs fresh.

## Data model

### `PlaneBotConfigSchema` (new in `packages/core/src/config-schemas.ts`)

```ts
export const PlaneBotConfigSchema = z.object({
  role: z.enum(["builder", "designer"]),
  userId: z.string().uuid(),
  token: z.string().min(1),
  systemPrompt: z.string().min(1),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  mcpConfigPath: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  bypassPermissions: z.boolean().optional(),
});

export type PlaneBotConfig = z.infer<typeof PlaneBotConfigSchema>;
```

### `RepositoryConfig` changes

Add:

```ts
planeBots: z.array(PlaneBotConfigSchema).optional().superRefine((bots, ctx) => {
  if (!bots) return;
  const seen = new Set<string>();
  for (const b of bots) {
    if (seen.has(b.userId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate bot userId ${b.userId} in planeBots`,
      });
    }
    seen.add(b.userId);
  }
}),
```

Mark as deprecated (Zod schema keeps them so existing `config.json` files still parse, but the runtime no longer reads them — the values live on the bot now):

- `planeBypassPermissions`
- `planeMaxTurns`

If both repo-level (deprecated) and bot-level fields are set in the same config, the bot-level wins silently. Operators are expected to clean the deprecated fields out as part of migration.

Untouched: `planeProjectId`, `planeAgentLabelIds` (label filter stays repo-wide; the role is decided by assignee, not by label).

### `PlaneSessionStore` entry

```ts
type PlaneSessionEntry = {
  claudeSessionId: string;
  projectId: string;
  workspaceSlug: string;
  botUserId?: string;       // NEW; optional for legacy compatibility on load
  updatedAt: number;
};
```

Loading a legacy entry (without `botUserId`) is fine — cross-check downgrades to "no resume" rather than failing.

### Example `config.json` after migration

```json
{
  "id": "panfleet",
  "planeProjectId": "35502ab9-d5b6-4397-9917-732a69eb9dd4",
  "planeAgentLabelIds": [],
  "planeBots": [
    {
      "role": "builder",
      "userId": "3322520e-b959-4cbd-8b7c-929b05e445da",
      "token": "plane_api_<builder-token>",
      "systemPrompt": "Eres @builder, un agente que implementa issues asignados. Trabajas en una rama dedicada al issue, haces los cambios pedidos, commiteas y abres un PR contra origin/main. Si el usuario añade un comentario al issue mientras trabajas, considéralo como una nueva instrucción y ajústate a ella en el siguiente turno.",
      "mcpConfigPath": "/home/cyrus/.cyrus/mcp-configs/builder.json",
      "maxTurns": 40,
      "bypassPermissions": true
    },
    {
      "role": "designer",
      "userId": "<designer-uuid>",
      "token": "plane_api_<designer-token>",
      "systemPrompt": "Eres @designer, un agente de UX/UI que diseña sobre Figma. Tu output son cambios en archivos Figma (frames, componentes, tokens, variantes) y comentarios en Plane describiendo el porqué del diseño con links/screenshots. NO podés editar código, ni correr comandos, ni abrir PRs. Si el issue pide código, postea un comentario explicando que el cambio requiere a @builder y dejá la propuesta visual en Figma.",
      "allowedTools": ["Read", "WebFetch", "WebSearch", "mcp__figma__*", "mcp__plane__*"],
      "disallowedTools": ["Edit", "Write", "Bash", "NotebookEdit"],
      "mcpConfigPath": "/home/cyrus/.cyrus/mcp-configs/designer.json",
      "maxTurns": 25,
      "bypassPermissions": true
    }
  ]
}
```

## Components and changes

### `packages/core/src/config-schemas.ts` (~30 lines)

- Add `PlaneBotConfigSchema` and `PlaneBotConfig` type.
- Add `planeBots` field to `RepositoryConfigSchema` with the duplicate-userId superRefine.
- Add inline JSDoc marking `planeBypassPermissions` and `planeMaxTurns` as deprecated.

### `packages/plane-event-transport/src/PlaneIssueTrackerService.ts` (~20 lines)

- Constructor signature: `apiToken` becomes optional.
- All read/write methods accept an optional `opts?: { tokenOverride?: string }` final arg. When set, use that override as `X-API-KEY`; otherwise fall back to the constructor token.
- Throw a clear error if neither is set when a request is made.
- For `fetchIssue` calls inside `EdgeWorker.handlePlaneEvent` (comment branch — used to resolve project): pass the **first bot's token from the candidate repo** as `tokenOverride`. Every Plane-routed repo is guaranteed by the startup validation to have at least one bot.
- For `createComment` and other writes: always pass the resolved `bot.token` so the action is authored by the right identity.
- No method silently uses an undefined token.

### `packages/plane-event-transport/src/PlaneEventTransport.ts` (~20 lines)

- Replace `botUserId: string` config field with `botUserIds: string[]`.
- `translatePayload` checks `any(botUserIds[i] ∈ newAssignees)` instead of single-equality.
- Emitted `PlaneAgentEvent` shape is unchanged — bot resolution stays in `EdgeWorker`.

### `packages/edge-worker/src/EdgeWorker.ts` (~80 lines)

- `registerPlaneEventTransport()`:
  - Stop reading `PLANE_BOT_USER_ID`/`PLANE_BOT_TOKEN`. If present, log a one-time deprecation warning.
  - Compute `botUserIds` by flat-mapping `repo.planeBots ?? []` across configured repos.
  - Construct `PlaneIssueTrackerService` with `apiToken: undefined`.
  - Construct `PlaneEventTransport` with `botUserIds`.
- `validatePlaneConfig()` (new helper):
  - For each repo with `planeProjectId`, require non-empty `planeBots[]`. Fatal-skip the repo's Plane wiring otherwise.
  - Reject duplicate `userId` across the union of all repos' `planeBots` (Zod superRefine cannot see across repos). Fatal-skip the offending repos.
  - At the end, log the resolved bot table: `"Plane bots loaded: builder=<uuid>, designer=<uuid>"`.
- `handlePlaneEvent`:
  - Assignment branch: resolve repo by `planeProjectId`, then resolve bot via `event.issue.assignees ∩ repo.planeBots[].userId`. Zero match → drop info-log. Multi-match → warn + pick `planeBots[0]`.
  - Comment branch: after iterating repos to find `fullIssue`, resolve bot the same way against `fullIssue.assignees`. Prefer `sessionStore.get(issueId).botUserId` when set (more robust if assignees changed mid-session).
- Pass resolved `bot` to `PlaneSessionRunner.handleAssignment(event, repo, bot)` / `.handleComment(event, repo, fullIssue, bot)`.

### `packages/edge-worker/src/PlaneSessionRunner.ts` (~50 lines)

- `handleAssignment(event, repo, bot: PlaneBotConfig)` — extra `bot` param.
- `handleComment(event, repo, fullIssue, bot: PlaneBotConfig)` — extra `bot` param. Cross-check rules for the resume decision:
  - `stored.botUserId === bot.userId` → resume with `resumeSessionId`.
  - `stored.botUserId !== bot.userId` (different bot) → fresh session (no `resumeSessionId`), warn-log the swap.
  - `stored.botUserId === undefined` (legacy entry from before this change) → conservative fresh session, no warn (it's expected during transition).
- `runWithStreaming(params)` — `params.bot` added. Use:
  - `bot.systemPrompt` as `systemPrompt`
  - `bot.allowedTools` / `bot.disallowedTools` (fall back to repo-level for backwards compat during transition; remove fallback once the migration is done)
  - `bot.mcpConfigPath`
  - `bot.maxTurns ?? DEFAULT_MAX_TURNS`
  - `bot.bypassPermissions ?? true` → controls `--dangerously-skip-permissions`
- Remove `buildSystemPrompt()` function (lives in config now).
- Acknowledge / error / final comments all route through `tracker.createComment(..., { tokenOverride: bot.token })`.
- `PlaneClaudeActivityPoster` is constructed with `postComment: (html) => tracker.createComment(issueId, projectId, html, { tokenOverride: bot.token })` so streamed activities are authored by the right bot.
- `persistSessionId` stores `botUserId: bot.userId` in the entry.

### `packages/edge-worker/src/PlaneSessionStore.ts` (~10 lines)

- Extend serialized entry shape with optional `botUserId`.
- Load-side tolerates missing field (treat as undefined; downstream handles).

## Data flow (high level)

### Assignment to `@designer`

1. Plane delivers webhook → HMAC verify → dedupe.
2. `PlaneEventTransport.translatePayload(payload, botUserIds)` matches `designerUUID` in new assignees → emits `issue.assigned_to_bot`.
3. `EdgeWorker.handlePlaneEvent`: resolve repo by `planeProjectId`; resolve bot by intersecting `event.issue.assignees` with `repo.planeBots[].userId` → `designerBot`.
4. `PlaneSessionRunner.handleAssignment(event, repo, designerBot)`:
   - Acknowledge with `designerBot.token` (comment authored by `@designer` in Plane).
   - Worktree (unchanged).
   - Spawn `claude` with `designerBot.systemPrompt`, `designerBot.allowedTools`, etc.
   - Stream activities → comments authored by `@designer`.
   - On complete: `PlaneSessionStore.set(issueId, { ..., botUserId: designerBot.userId })`.

### Comment on a designer-owned issue

1. Webhook emits `comment.created_on_bot_issue`.
2. `EdgeWorker.handlePlaneEvent` resolves project + bot (assignees say `designerBot`, store also says `designerBot` → consistent).
3. `PlaneSessionRunner.handleComment(event, repo, fullIssue, designerBot)`:
   - Live runner exists → `addStreamMessage` (no respawn).
   - Live runner dead + `stored.botUserId === designerBot.userId` → respawn with `resumeSessionId`.
   - Live runner dead + `stored.botUserId !== designerBot.userId` → respawn fresh (no resume), log warn.

### Multi-bot in assignees

If both `@builder` and `@designer` are assigned at webhook time, log warn and pick `planeBots[0]`. Documented behavior; operators learn to assign only one bot at a time.

## Error handling

| Situation | Behavior |
|---|---|
| `repo.planeProjectId` set but `planeBots` empty | Fatal at startup for that repo; skip Plane wiring; other repos continue. |
| Duplicate `userId` within one repo's `planeBots[]` | Zod schema rejects at load. |
| Same `userId` reused across two different repos | `validatePlaneConfig` rejects at startup (fatal-skip both repos' Plane wiring with a clear log). Zod alone can't catch this — superRefine only sees within a single array. |
| `bot.token` invalid (Plane 401 on `createComment`) | Catch + error log with `bot.role` + `bot.userId` (never the token). Runner continues; comments lost until operator rotates. |
| `bot.mcpConfigPath` missing/broken | Claude logs internally, MCP not loaded, session proceeds without it. Visible via missing MCP tools in transcript. |
| Designer tries `Edit`/`Write`/`Bash` | Claude Code's permission layer denies inline. Model adapts; runner does not crash. |
| Comment with no bots in `assignees` | Drop info-log (issue was un-assigned from all bots). |
| Comment with multiple bots in `assignees` | Prefer `stored.botUserId` if present; else `planeBots[0]`; warn either way. |
| Assignees changed mid-session (e.g., builder → designer) | Cross-check at comment time → fresh session (no resume), warn. |
| Legacy env `PLANE_BOT_USER_ID`/`PLANE_BOT_TOKEN` present | Warn at startup, ignored. Not fatal — allows in-place migration. |

## Testing

### Unit tests (new)

**`config-schemas.test.ts`** — 5 cases on `PlaneBotConfigSchema`:
- Full valid config parses.
- Minimal valid config parses (only required fields).
- Non-UUID `userId` rejected.
- Empty `token` rejected.
- Duplicate `userId` in `planeBots[]` rejected.

**`EdgeWorker.plane-bot-routing.test.ts`** — 6 cases:
- Single-bot match on assignment → dispatch with that bot.
- Multi-bot match on assignment → warn + dispatch with `planeBots[0]`.
- Zero-bot match on assignment → drop, no dispatch.
- Single-bot match on comment → dispatch with that bot.
- Empty assignees on comment → drop.
- Comment where `stored.botUserId` differs from resolved bot → dispatch with resolved bot, fresh session (no `resumeSessionId`).

**`PlaneIssueTrackerService.test.ts`** — extend with 3 cases:
- No `opts` → uses constructor token.
- `{ tokenOverride }` → uses the override in `X-API-KEY`.
- No constructor token and no override → throws a clear error.

**`PlaneEventTransport.translatePayload`** — extend with 3 cases:
- `assignee_ids` activity with bot A in added → emits.
- `assignee_ids` activity with bot B in added → emits.
- `assignee_ids` activity with none → no emit.

**`PlaneSessionRunner.test.ts`** — extend with 5 cases:
- `handleAssignment` passes `bot.systemPrompt`, `allowedTools`, `disallowedTools`, `mcpConfigPath`, `maxTurns`, `bypassPermissions` into `claudeRunnerFactory`.
- Acknowledge `createComment` is invoked with `{ tokenOverride: bot.token }`.
- `persistSessionId` writes `botUserId` to the store entry.
- `handleComment` with matching `stored.botUserId` → passes `resumeSessionId`.
- `handleComment` with mismatched `stored.botUserId` → no `resumeSessionId`, warn logged.

**`PlaneSessionStore.test.ts`** — extend with 2 cases:
- Round-trip with `botUserId` set.
- Load tolerates legacy entries without `botUserId`.

### Modified existing tests

- Existing `PlaneSessionRunner` tests get a `mockBot` parameter added to their `handleAssignment` / `handleComment` calls (mechanical refactor, ~10 tests).
- `EdgeWorker.plane-comment-routing.test.ts` adapted so mocks include `planeBots`.

### Smoke test (manual, post-deploy)

Order matters — bot setup before code deploy.

**Pre-flight in Plane CE** (one-time, manual):

1. Create user `designer@bot.pulp.lan` via `/auth/sign-up/` (form-encoded, no SMTP).
2. Accept workspace invitation to `panfleet`.
3. INSERT into `project_members` for the Panfleet project (UUID `35502ab9-d5b6-4397-9917-732a69eb9dd4`).
4. Generate API token via `POST /api/users/api-tokens/`.
5. Capture the designer UUID + token.

**Pre-flight on the LXC**:

6. Create `~/.cyrus/mcp-configs/builder.json` (Plane MCP with builder token; no Figma).
7. Create `~/.cyrus/mcp-configs/designer.json` (Plane MCP with designer token; Figma HTTP MCP shared from the existing `plane.json`).
8. Migrate `~/.cyrus/config.json` to remove env-based `PLANE_BOT_*` and add `planeBots[]` with both entries.
9. Remove `PLANE_BOT_USER_ID` / `PLANE_BOT_TOKEN` from `/home/cyrus/.cyrus/.env`.

**Deploy**: `git fetch && git reset --hard origin/feat/plane-designer-role && pnpm build && systemctl restart cyrus`.

**Smoke issues**:

- **PFL-N1 (builder regression)**: assign existing-style issue to `@builder` → behavior identical to today (worktree, code, PR). Confirms migration didn't regress.
- **PFL-N2 (designer happy path)**: e.g. "Rediseñar el splash screen del onboarding", assign to `@designer`. Expect: ack by `@designer`; Figma MCP calls visible in transcript; final comment with Figma URL; worktree exists but `git status` clean (no commits, no edits); no PR created.
- **PFL-N3 (designer multi-turn)**: after PFL-N2 completes, comment "usa brand-blue en vez del primary". Expect: resume with designer (same `claudeSessionId`).
- **PFL-N4 (cross-bot, optional)**: assign issue to `@designer`, let complete, then reassign to `@builder` and comment. Expect: warn log about cross-bot, fresh session with builder, no resume.

## Migration

This change **breaks** the current single-bot deployment because the env vars are no longer read. Order matters — config must be migrated **before** the new code starts, otherwise startup validation fails the Panfleet repo wiring (and the operator gets a clear error log to act on).

1. Create `@designer` in Plane (steps 1–5 of pre-flight).
2. Build two MCP config files (steps 6–7).
3. Rewrite `~/.cyrus/config.json` to add `planeBots[]` (step 8). Keep deprecated repo-level fields untouched at this step; the new code ignores them.
4. Remove env vars from `.env` (step 9). (Safe to leave them in — they get warn-ignored — but cleaner to remove.)
5. `git fetch && git reset --hard origin/feat/plane-designer-role && pnpm build && systemctl restart cyrus`.
6. Verify in `journalctl -u cyrus -f`: "Plane event transport registered" and "Plane bots loaded: builder=<uuid>, designer=<uuid>".

Legacy entries in `plane-sessions.json` without `botUserId` continue to load; the cross-check downgrades them to "fresh session on next comment". No data loss.

## Open questions

- None at design time. The `role` enum is intentionally narrow (`builder` | `designer`) and can be widened in a future change without breaking compatibility.

## Out-of-scope follow-ups (for after this lands)

- Per-bot logs / metrics in `journalctl` (currently the runner just logs `botRole` as a string; counting per-role runs needs structured aggregation).
- Admin endpoint to stop / drain a single bot without restarting the service.
- Sub-role variants (`debugger`, `implementer`, `reviewer`) — same shape, just more entries in the enum + concrete prompts/tools.
- Per-bot Plane workspace (currently `PLANE_BASE_URL` + `PLANE_WORKSPACE_SLUG` are global).
