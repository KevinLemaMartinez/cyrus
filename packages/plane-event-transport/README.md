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
| Fetch issue, current user, create comment, update issue | ✅ (5 of 22 `IIssueTrackerService` methods) |
| Multi-turn (replies to comments) | ❌ TODO |
| Labels as trigger | ❌ TODO |
| Multiple roles (designer / implementer / builder / debugger) | ❌ POC ships only `@builder` |
| Tool restrictions per role | ❌ TODO |
| Agent Activity styling (thought / action / response) | ❌ Plain comments in POC |

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

## Plane-side prerequisites

1. Workspace with at least one project.
2. A bot user (e.g. `builder@bot.pulp.lan`) added as a member.
3. An API key generated for that bot (Settings → API Tokens).
4. A webhook configured pointing to the runner: Settings → Webhooks → URL `https://<runner-host>/plane-webhook`, with a shared secret. Subscribe to **Issue** events.

## Open questions (to resolve in next iterations)

- **HMAC header name**: documented as `x-plane-signature` here based on convention; needs verification against `makeplane/plane` source.
- **Issue identifier resolution**: Plane API addresses issues by UUID; the `PFL-123` style identifier requires a project lookup. POC only accepts UUIDs.
- **`AgentSession` modeling**: in Linear it is a first-class entity; in Plane CE there is no equivalent. POC treats the issue itself as the session — every "activity" is a regular comment.
- **`AgentEventTransportConfig` in core**: the discriminated union in `cyrus-core` currently knows only `linear` and `cli`. Adding `plane` requires editing core. Tracked as a follow-up.

## License

MIT — same as the rest of Cyrus.
