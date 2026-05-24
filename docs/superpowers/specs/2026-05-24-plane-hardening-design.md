# Plane carril — Hardening (multi-turn + guards)

Spec del **POC+1** del carril Plane CE en Cyrus. Estado de partida: POC cerrado en H6 (2026-05-23), deploy en LXC 110 (`cyrus.pulp.lan @ 192.168.0.45`), smoke test PFL-11 pasando end-to-end. Este spec describe las cuatro mejoras de hardening que cierran las limitaciones identificadas en el backlog del POC.

## Objetivo

Cerrar las limitaciones funcionales del carril Plane sin romper el smoke test actual:

1. **Multi-turn vía comentarios** — paridad funcional 1:1 con el flujo `agentSessionPrompted` de Linear (`handlePromptWithStreamingCheck`): si el runner está activo → `addStreamMessage`; si el runner ya terminó → spawn nuevo con `resumeSessionId`.
2. **`dangerously-skip-permissions` configurable** — hoy hardcoded en `PlaneSessionRunner`; pasa a flag per-repo `planeBypassPermissions` (default `true` por la razón documentada en *Implicaciones de seguridad*).
3. **`maxTurns` configurable** — hoy sin límite; default `40`, override per-repo `planeMaxTurns`.
4. **Filtro por label opt-in** — hoy cualquier issue asignado al bot dispara; opt-in con `planeAgentLabelIds: string[]` (UUIDs de Plane labels) en `RepositoryConfig`.

## Componentes

### 1. `packages/plane-event-transport/src/plane-webhook-utils.ts`

`translatePayload` deja de devolver `null` para comentarios. Reglas nuevas para `issue_comment`:

- Solo `action === "created"`.
- Solo si `comment.actor !== ctx.botUserId` (anti-loop, el bot no se responde).
- Devuelve `{ type: "comment.created_on_bot_issue", issue: <stub>, comment, projectId, workspaceSlug, actor: syntheticActor(comment.actor) }`.

**El webhook de comment NO trae el issue expandido** (`PlaneComment.issue: string` es UUID, no `PlaneIssue`). El translator no puede comprobar "el bot está asignado al issue parent" — esa verificación se delega a `handlePlaneEvent` (que sí puede hacer fetch).

Para reflejar honestamente la realidad del webhook en el sistema de tipos, **cambiamos la shape de la variante `comment.created_on_bot_issue`**: el campo `issue: PlaneIssue` pasa a `issueId: string`. El único consumidor actual de esta variante (`EdgeWorker.handlePlaneEvent`, hoy ignora el evento) se actualiza en el mismo PR.

```typescript
// Antes
| { type: "comment.created_on_bot_issue"; issue: PlaneIssue; comment; projectId; workspaceSlug; actor }

// Después
| { type: "comment.created_on_bot_issue"; issueId: string; comment; projectId; workspaceSlug; actor }
```

### 2. `packages/core/src/config-schemas.ts`

Tres campos opcionales nuevos en `RepositoryConfigSchema`, junto al `planeProjectId` ya existente:

```typescript
planeAgentLabelIds: z.array(z.string().uuid()).optional(),
planeBypassPermissions: z.boolean().optional(),
planeMaxTurns: z.number().int().positive().optional(),
```

Semántica:
- `planeAgentLabelIds` — si `undefined` o `[]`, cualquier issue asignado dispara. Si tiene UUIDs, solo issues que contengan al menos uno de esos labels.
- `planeBypassPermissions` — si `undefined`, default `true` (mantiene comportamiento POC). Si `false`, el `extraArgs` no incluye `dangerously-skip-permissions`.
- `planeMaxTurns` — si `undefined`, default `40`. Pasa al `ClaudeRunnerConfig.maxTurns`.

### 3. `packages/edge-worker/src/PlaneSessionStore.ts` (nuevo)

Mini-store para persistir `lastClaudeSessionId` por `issueId`. Razón: paridad de comportamiento con Linear (que persiste vía `PersistenceManager`), pero sin acoplar con la maquinaria `AgentSessionManager`/`CyrusAgentSession` que es Linear-específica.

```typescript
interface PlaneStoredSession {
  claudeSessionId: string;
  projectId: string;
  workspaceSlug: string;
  updatedAt: number;
}

class PlaneSessionStore {
  constructor(opts: { storePath: string; logger?: ILogger });
  async load(): Promise<void>;
  get(issueId: string): PlaneStoredSession | undefined;
  async set(issueId: string, entry: PlaneStoredSession): Promise<void>;
  async delete(issueId: string): Promise<void>;
}
```

Implementación:
- In-memory `Map<issueId, PlaneStoredSession>`.
- Persist a `~/.cyrus/plane-sessions.json` (path configurable, derivado de `cyrusHome`).
- Escritura atómica: `writeFile(tmp)` + `rename(tmp, final)`.
- Cleanup pasivo: en cada `set`, purga entradas con `updatedAt` más viejas que 30 días.
- `load()` tolerante: si el archivo no existe → mapa vacío; si JSON inválido → log error y mapa vacío (no fail-fast del proceso).

### 4. `packages/edge-worker/src/PlaneSessionRunner.ts` (refactor)

Cambios estructurales:

- `private readonly active: Set<ClaudeRunnerHandle>` → `private readonly active: Map<string, ClaudeRunnerHandle>` (key = `issueId`).
- Inyección nueva en `PlaneSessionRunnerConfig`: `sessionStore: PlaneSessionStore`.
- `ClaudeRunnerFactory` mantiene la firma actual `(config: ClaudeRunnerConfig) => ClaudeRunnerHandle`. `keepSessionWarm` permanece en `false` (paridad Linear: el runner muere tras `result` y los siguientes turnos se hacen vía resume). El factory default en `EdgeWorker` ya construye `new ClaudeRunner(claudeConfig)` sin segundo arg — no requiere cambios.

Método nuevo: `handleComment(event, repo, fullIssue: PlaneIssueRef)`:

El handler recibe el `PlaneIssueRef` (shape REST, ya fetched por `EdgeWorker`) como tercer argumento, separado del `event` (que solo lleva `issueId`). Razón: la shape REST difiere de la shape webhook (`state` y `assignees` son UUIDs en REST; objetos expandidos en webhook). Pasarlo explícito y tipado evita el cast feo.

```
1. const issueId = event.issueId.
2. Lookup runner en this.active.get(issueId).
3. Si existe y .isRunning() y supportsStreamingInput → .addStreamMessage(commentText). Done.
4. Si no existe:
   a. Lookup sessionStore.get(issueId) → si vacío, postear comentario "no hay sesión previa para este issue, vuélveme a asignar para empezar"; return.
   b. Si existe stored.claudeSessionId → spawn nuevo runner con resumeSessionId, startStreaming(commentText).
5. Wire poster + lifecycle (igual que handleAssignment).
```

`buildMinimalIssue` se ajusta para aceptar `PlaneIssue | PlaneIssueRef`: la única lectura sensible al shape es `issue.state.id` (webhook) vs `issue.state` (REST, ya UUID). Helper interno `extractStateId(issue)` normaliza.

Cambios en `handleAssignment`:
- `claudeRunnerFactory({ ..., resumeSessionId: undefined, maxTurns, extraArgs })` donde `extraArgs` contiene `dangerously-skip-permissions: null` solo si `repo.planeBypassPermissions !== false`.
- `runnerHandle.start(prompt)` → `runnerHandle.startStreaming(prompt)`.
- Tras complete, antes del `finally`, leer `runner.getSessionInfo()?.sessionId` y `sessionStore.set(issueId, { claudeSessionId, projectId, workspaceSlug, updatedAt: Date.now() })`.
- En el `finally`, `this.active.delete(issueId)`.

System prompt actualizado (self-describing): el modelo recibe en el prompt inicial una nota indicando que pueden llegar comentarios mid-session y que debe tratarlos como nueva guía del usuario. Justificación: CLAUDE.md §"Routing Behavior & Self-Describing Prompts" — cuando cambian las capacidades, el prompt debe describirlas. Plane no pasa por `PromptBuilder` (carril propio), así que el cambio vive directamente en `PlaneSessionRunner`.

### 5. `packages/edge-worker/src/EdgeWorker.ts` — `handlePlaneEvent`

```
async handlePlaneEvent(event) {
  // 1. Resolver repo por planeProjectId (igual que hoy).
  const repo = ... .find(r => r.planeProjectId === event.projectId);
  if (!repo) { warn + drop; return; }

  // 2. Label filter (aplica a ambos branches).
  if (event.type === 'issue.assigned_to_bot') {
    if (!matchesLabelFilter(event.issue, repo)) { info + drop; return; }
    return runner.handleAssignment(event, repo);
  }

  if (event.type === 'comment.created_on_bot_issue') {
    // 3. Fetch issue (el webhook no expande): tracker.fetchIssue(event.issueId, projectId).
    const fullIssue = await planeIssueTracker.fetchIssue(event.issueId, event.projectId);
    if (!fullIssue) { warn + drop; return; }

    // 4. Bot debe ser assignee (anti-spam: no procesamos comentarios en issues que ni siquiera tienen el bot).
    if (!fullIssue.assignees.includes(botUserId)) { info + drop; return; }

    // 5. Label filter.
    if (!matchesLabelFilter(fullIssue, repo)) { info + drop; return; }

    return runner.handleComment(event, repo, fullIssue);
  }
}

function matchesLabelFilter(issue: PlaneIssue | PlaneIssueRef, repo) {
  if (!repo.planeAgentLabelIds?.length) return true; // opt-in: vacío = todo
  return issue.labels.some(labelId => repo.planeAgentLabelIds.includes(labelId));
}
```

`matchesLabelFilter` tolera ambas shapes porque `labels: string[]` (UUIDs) es idéntico en `PlaneIssue` y `PlaneIssueRef`. `assignees` también difiere (objetos vs UUIDs); el check `botUserId in assignees` se hace solo en el branch comment, contra el REST ref (UUIDs).

## Data flow

**Assignment (existente, modificado)**:
```
webhook /plane-webhook
  → translatePayload → issue.assigned_to_bot
  → EdgeWorker.handlePlaneEvent
    → match repo by planeProjectId
    → label filter
    → PlaneSessionRunner.handleAssignment(event, repo)
      → tracker.createComment ack
      → gitService.createGitWorktree
      → claudeRunnerFactory({ ..., maxTurns, extraArgs(bypass) })
      → runner.startStreaming(prompt)
      → on complete: sessionStore.set(issueId, { claudeSessionId, ... })
      → active.delete(issueId)
```

**Comment (nuevo)**:
```
webhook /plane-webhook (event=issue_comment, action=created)
  → translatePayload → comment.created_on_bot_issue (issueId, comment, actor != bot)
  → EdgeWorker.handlePlaneEvent
    → match repo by planeProjectId
    → tracker.fetchIssue(event.issueId, event.projectId) → PlaneIssueRef [REST call adicional]
    → check botUserId in fullIssue.assignees (UUID array)
    → matchesLabelFilter(fullIssue, repo)
    → PlaneSessionRunner.handleComment(event, repo, fullIssue)
      → active.get(event.issueId)
        → if running + supportsStreamingInput: addStreamMessage(text); done.
        → else: sessionStore.get(event.issueId)
          → if found: spawn runner with resumeSessionId, startStreaming(text)
          → if missing: comment "no previous session, reassign to start"; done.
```

## Error handling

- `tracker.fetchIssue` falla en el comment branch → log error, postear comentario "no pude leer el issue, reintenta más tarde", drop. No fail-fast.
- `sessionStore.load()` falla (JSON corrupto) → log error, in-memory vacío, continuar (la próxima `set` regenera el archivo).
- `runner.getSessionInfo()` devuelve `null` tras complete → log warning, no se persiste sessionId para ese issue (próximos comments crean sesión nueva fresh).
- Si `addStreamMessage` lanza (e.g. runner murió entre el check y la llamada) → fallback a la rama "spawn resume" en el mismo `handleComment`.
- Label filter drop → log a info level (no warn) — drop esperado por diseño.

## Implicaciones de seguridad (CLAUDE.md §"Two Separate Permission Systems")

`planeBypassPermissions = false` desactiva `dangerously-skip-permissions`. El `ClaudeRunner` entonces pedirá confirmación para tools como Edit/Write/Bash. **`PlaneSessionRunner` no tiene `onAskUserQuestion` wireado** — un permission prompt en este modo se quedaría colgado indefinidamente.

Por eso el default es `true`. Quien quiera apagarlo debe asumir que ha configurado `allowedTools` lo suficientemente exhaustivo como para que el modelo nunca dispare una tool no permitida. Documentado en el changelog y en el comentario inline del campo.

*Out of scope para este PR*: implementar `onAskUserQuestion` → comentario Plane con opciones. Costoso (necesita callback de respuesta vía webhook), backlog POC+2.

## Testing

CONTRIBUTING.md upstream pide Vitest. Plan de tests por archivo:

- **`packages/plane-event-transport/test/plane-webhook-utils.test.ts`** — añadir:
  - `translatePayload` emite `comment.created_on_bot_issue` cuando `event=issue_comment, action=created, actor != botUserId`.
  - `translatePayload` devuelve `null` cuando `actor == botUserId` (anti-loop).
  - `translatePayload` devuelve `null` para `action != created`.

- **`packages/edge-worker/test/PlaneSessionRunner.test.ts`** — extender:
  - `handleComment` con runner activo → llama `addStreamMessage`.
  - `handleComment` sin runner activo pero con sessionId persistido → spawn nuevo con `resumeSessionId`.
  - `handleComment` sin runner ni sessionId → postea comentario "no previous session" y no spawnea.
  - `handleAssignment` persiste `claudeSessionId` tras complete.
  - `handleAssignment` respeta `repo.planeBypassPermissions = false` (no incluye flag en `extraArgs`).
  - `handleAssignment` respeta `repo.planeMaxTurns` (pasa al config).

- **`packages/edge-worker/test/PlaneSessionStore.test.ts`** (nuevo):
  - `load` con archivo inexistente → mapa vacío.
  - `load` con JSON inválido → mapa vacío + log error.
  - `set` escribe atómicamente y `get` lo recupera.
  - `set` purga entradas > 30 días al escribir.
  - `delete` quita entrada.

- **`packages/edge-worker/test/EdgeWorker.test.ts`** (si existe; sino archivo nuevo focused en `handlePlaneEvent`):
  - `handlePlaneEvent` con `comment.created_on_bot_issue` y bot no en assignees → drop.
  - `handlePlaneEvent` con label filter configurado y issue sin label → drop.
  - `handlePlaneEvent` con label filter configurado y issue con label → procesa.

Validación E2E manual (sustituto de F1, que no aplica a Plane):
- LXC `cyrus.pulp.lan` con build de la branch hardening.
- Issue de prueba en Panfleet asignado al bot → smoke test PFL-N idéntico al de H6.
- Comentario añadido durante la sesión → assert `addStreamMessage` en logs + nuevo turn en activitybar.
- Comentario añadido tras PR cerrado/mergeado → assert resume nuevo runner con `resumeSessionId` distinto en logs.
- Issue sin label "agent-ok" (UUID configurado en `planeAgentLabelIds`) → assert drop en logs sin spawn.

## Cumplimiento con CONTRIBUTING.md upstream y CLAUDE.md

Checklist concreto antes del commit y antes de un eventual PR a `cyrusagents/cyrus`:

- [ ] `pnpm install` (si cambian deps; este PR no añade).
- [ ] `pnpm format` (Biome).
- [ ] `pnpm typecheck` (Husky pre-commit lo ejecuta; falla = no commit).
- [ ] `pnpm lint` (Biome).
- [ ] `pnpm test:packages:run` (todos los tests passing, incluyendo los 18 actuales de Plane + los nuevos).
- [ ] `pnpm build` (compila limpio).
- [ ] `CHANGELOG.md` con entrada bajo `## [Unreleased]`:
  - `### Added`: comentarios en issues Plane ahora se inyectan a la sesión activa o reanudan el último Claude session (paridad multi-turn con el flujo Linear); filtro opcional por label con `planeAgentLabelIds`.
  - `### Changed`: el bypass `dangerously-skip-permissions` deja de estar hardcoded; controlado por `planeBypassPermissions` per-repo (default `true` por la razón documentada en *Implicaciones de seguridad*).
  - `### Added`: `planeMaxTurns` per-repo, default 40, para limitar la longitud de una sesión Plane.
  - (Sin Linear issue identifier — el carril Plane no tiene tracker upstream; se añade al abrir PR si se decide sondear).
- [ ] Smoke test E2E en LXC pasa (sustituto de F1 para Plane).

## Riesgos y mitigaciones

- **Llamada REST extra en cada comment** (`fetchIssue`). Latencia ~100-300ms contra Plane LXC. Aceptable; el usuario espera el ack y verá el efecto en el siguiente turn de Claude. Mitigación opcional (POC+2): cache TTL corto issueId → assignees.
- **Race entre check `isRunning()` y `addStreamMessage`**: si el runner termina justo entre las dos líneas, `addStreamMessage` puede lanzar "not in streaming mode". El handler captura el error y cae al branch "spawn resume" como fallback.
- **Múltiples comments concurrentes en el mismo issue**: el `Map<issueId, runner>` solo guarda uno. Si dos webhooks de comment llegan en paralelo y ambos van por la rama "spawn", el segundo sobrescribe al primero en el map; el primero queda colgado hasta que termine. Mitigación: el dedupe FIFO por `x-plane-delivery` (existente desde H5) ya cubre el caso "mismo webhook recibido dos veces"; el caso "dos comments distintos rápidos seguidos" se mitiga aceptando el segundo y dejando al primero correr en background (`active.set` overwrite no detiene al primer runner, solo deja de poder añadirle messages — al terminar, intentará persistir sessionId pero el `.delete(issueId)` puede pisar al segundo). **Decisión: aceptar este edge case en POC+1**; documentado.
- **`PlaneSessionStore` corruption por escritura concurrente**: dos comments para issues distintos podrían intentar `set` al mismo tiempo. Mitigación: serializar `set` con un mutex interno (cola FIFO). Implementación simple: `private writeQueue: Promise<void> = Promise.resolve(); set() { this.writeQueue = this.writeQueue.then(() => this.actualWrite(...)); return this.writeQueue; }`.
- **Migración del config**: añadir 3 campos opcionales a `RepositoryConfigSchema`. Backward compatible — configs existentes siguen funcionando (todos opcionales con defaults razonables).

## Out of scope (explicit)

- `onAskUserQuestion` para Plane (permission prompts vía comentarios).
- F1 test drive equivalente para Plane.
- Documentar `NODE_EXTRA_CA_CERTS` shell-export en `SELF_HOSTING.md` (backlog separado).
- Multi-workspace Plane (varios `PLANE_*` env sets) — sigue siendo un único workspace/bot global como en POC.
- Cache TTL de assignees para ahorrar fetchIssue.
- Activación del egress sandbox para sesiones Plane.

## Resumen ejecutivo

Cuatro cambios coordinados; un PR. Multi-turn replica el patrón Linear sin keepSessionWarm. Tres guards (bypass, maxTurns, label filter) per-repo opcionales con defaults seguros. Nuevo `PlaneSessionStore` para persistir `lastClaudeSessionId` por issueId — paridad de comportamiento con Linear sin acoplar a `AgentSessionManager`. Tests Vitest por componente. Smoke E2E manual en LXC sustituye a F1 (no aplicable a Plane). Cumple CONTRIBUTING.md y CLAUDE.md upstream para preparar un eventual sondeo de PR.
