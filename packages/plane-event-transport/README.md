# cyrus-plane-event-transport

**Status: POC / work in progress.** Not production-ready.

Plane (Community Edition) adapter for [Cyrus](https://github.com/cyrusagents/cyrus). Receives Plane webhooks, verifies HMAC signatures, and emits canonical `PlaneAgentEvent`s that the Cyrus edge-worker consumes — the same way `cyrus-linear-event-transport` does for Linear.

## Why

Plane Community Edition does **not** include the "Plane Agents Beta" framework (that lives only in Plane Commercial). To use Cyrus with self-hosted Plane CE we need a custom event transport that bridges Plane's standard webhooks to Cyrus's agent runner.

## POC scope

| Capability | Status |
|---|---|
| Verify HMAC signature on incoming Plane webhooks | ✅ |
| Detect "issue assigned to bot user" → emit canonical event | ✅ |
| Dedupe deliveries by `x-plane-delivery` | ✅ |
| Fetch issue, current user, create comment, update issue | ✅ (5 of 22 `IIssueTrackerService` methods) |
| Wire into `EdgeWorker` (worktree + ClaudeRunner + comments) | ✅ |
| Multi-turn (replies to comments) | ❌ TODO |
| Labels as trigger | ❌ TODO |
| Multiple roles (designer / implementer / builder / debugger) | ❌ POC ships only `@builder` |
| Tool restrictions per role | ❌ TODO |
| Agent Activity styling (thought / action / response) | ✅ Streamed as per-message Plane comments |

## Files

```
src/
├── index.ts                       Public exports
├── types.ts                       Plane entities + webhook envelope + config
├── plane-webhook-utils.ts         HMAC verification + payload → canonical event
├── PlaneEventTransport.ts         Fastify endpoint /plane-webhook
├── PlaneIssueTrackerService.ts    Plane REST API client (POC subset)
└── PlaneMessageTranslator.ts      Placeholder (no-op in POC)
test/
└── plane-webhook-utils.test.ts    Unit tests for verification & translation
```

## EdgeWorker integration

Once the package is wired in (see `docs/superpowers/specs/2026-05-23-h5-plane-edge-worker-design.md`),
`cyrus` picks up Plane CE webhooks on the same Fastify server it uses for Linear/GitHub/Slack.

### Required env vars (read by `EdgeWorker.registerPlaneEventTransport`)

| Var | Example |
|---|---|
| `PLANE_BASE_URL` | `https://plane.pulp.lan` |
| `PLANE_WORKSPACE_SLUG` | `panfleet` |
| `PLANE_BOT_USER_ID` | `3322520e-b959-4cbd-8b7c-929b05e445da` |
| `PLANE_BOT_TOKEN` | `plane_api_…` |
| `PLANE_WEBHOOK_SECRET` | (matches the secret configured in Plane's webhook UI) |

If any var is missing, the `/plane-webhook` endpoint is **not** mounted; Plane events are simply not received.

### Repository routing

Add `planeProjectId` (UUID of the Plane project) to the relevant repository in `~/.cyrus/config.json`:

```json
{
  "repositories": [
    {
      "id": "panfleet",
      "name": "panfleet",
      "repositoryPath": "/Users/kevin/projects/panfleet",
      "baseBranch": "main",
      "workspaceBaseDir": "/Users/kevin/projects/cyrus-workspaces",
      "planeProjectId": "35502ab9-d5b6-4397-9917-732a69eb9dd4"
    }
  ]
}
```

Plane events whose `projectId` doesn't match any `planeProjectId` are logged and dropped.

### Smoke test

1. Configure a webhook in Plane CE → URL of the running cyrus EdgeWorker (`/plane-webhook`) + a shared secret. Subscribe to **Issue** events.
2. Set the env vars listed above in `~/.cyrus/.env` or in the process env.
3. Add the relevant repo to `~/.cyrus/config.json` with `planeProjectId`.
4. Start `cyrus`.
5. Create a Plane issue and assign it to the bot user.
6. Expected timeline on the Plane issue:
   - "👋 Recibí la asignación, arrancando…" (immediate).
   - One comment per assistant message / tool use / tool result while Claude works.
   - "✅ Sesión completada" comment when the run ends.
7. A git worktree appears at `<workspaceBaseDir>/PFL-<seq>/` and a PR is opened (or attempted) on the configured repo.

## Plane-side prerequisites

1. Workspace with at least one project.
2. A bot user (e.g. `builder@bot.pulp.lan`) added as a member.
3. An API key generated for that bot (Settings → API Tokens).
4. A webhook configured pointing to the runner: Settings → Webhooks → URL `https://<runner-host>/plane-webhook`, with a shared secret. Subscribe to **Issue** events.

## Open questions (to resolve in next iterations)

- **HMAC header name**: documented as `x-plane-signature` here based on convention; needs verification against `makeplane/plane` source.
- **Issue identifier resolution**: Plane API addresses issues by UUID; the `PFL-123` style identifier requires a project lookup. POC only accepts UUIDs.
- **`AgentSession` modeling**: in Linear it is a first-class entity; in Plane CE there is no equivalent. POC treats the issue itself as the session — every "activity" is a regular comment.

## License

MIT — same as the rest of Cyrus.
