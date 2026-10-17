# Spike: reload changed system prompts into existing sessions (next-turn semantics)

Status: findings + recommendation, not a shipping commitment. Baseline: `dev` @ `2ab4a4813e`.

## TL;DR

Next-turn reload is not only feasible — it is already the architecture HyperNeo committed to in
#4833 (`654432e081`): every prompt HyperNeo authors is sent with `snapshot: false`, so the CLI
re-renders it from the daemon's freshly built options at every spawn instead of replaying a prompt
recorded in the transcript. Two pieces are missing:

1. **No operation door.** Nothing outside the RPC `session.update` handler can change a session's
   prompt, and that door persists config but never restarts the query, so a live session keeps its
   spawn-time prompt until an unrelated restart happens to occur.
2. **No introspection.** There is no way to ask "what prompt is this session running, from which
   source, and is it stale?"

The recommended mechanism is **(a) next-turn re-injection**: persist the new prompt into
`session.config.systemPrompt` and restart the (idle) query, exactly the sequence
`refreshLongHorizonAgentSessionConfig` already runs for long-horizon agents. Transcript rewrite
**(b)** is unnecessary and unsupported; per-session stored override **(c)** is just the storage
half of (a) and already exists (`sessions.config.systemPrompt`).

Space long-horizon agents already get prompt reload today (lazily, on next message ensure). The
real gap is ordinary/project chats (no runtime-editable source, recorded base prompt) and ad-hoc
per-session overrides.

---

## 1. Where each session kind gets its system prompt

All session kinds converge on one place: `QueryOptionsBuilder.buildSystemPrompt()`
(`packages/daemon/src/lib/agent/query-options-builder.ts:682`), which reads
`session.config.systemPrompt` (a `SystemPromptConfig`: plain string, or
`{ type: 'preset', preset: 'claude_code', append? }`, or `{ type: 'custom', prompt }`) and joins it
with per-turn dynamic parts (space briefing, worktree isolation text).

| Kind | Creation site | `config.systemPrompt` at creation | Resolved shape at build |
| --- | --- | --- | --- |
| Ordinary chat (no space, no worktree) | RPC `session.create` (`session-handlers.ts:198`) | `undefined` (RPC callers *may* carry one; web UI does not) | bare `claude_code` preset, no append → **SDK-recorded** (`snapshot` default true) |
| Project chat (worktree) | RPC `session.create` | `undefined` | preset + append(worktree isolation) → `snapshot: false` |
| Space member chat | RPC `session.create` with `spaceId` | `undefined` | preset + append(space briefing) → `snapshot: false` |
| Neo root (`neo:` binding kind `neo`) | `neo/service.ts:305` (`ensureCoordinator`) | `neoPrompt(null)` string | `restrictNeoQuery` **overrides options.systemPrompt at every build** (`neo/session-policy.ts:41`), `{ type:'custom', snapshot:false }` |
| Neo holder / concern (kind `concern`) | same path, `neoPrompt(concernId)` | `neoPrompt(concernId)` string | same forced override, `snapshot:false` |
| Neo work session (kind `worker`) | `neo/service.ts:388` | `{ type:'preset', append: <static brief> }` | preset + append → `snapshot: false` |
| Space long-horizon agent | `space-runtime-service.ts:715` via `buildAgentSessionConfig` (`session-resolution/agent-session-config.ts:45`) | `{ type:'preset', append: agent.instructions + owner-review contract + scheduling guardrail }` (`agent-session-config.ts:124-136`) | preset + append → `snapshot: false` |
| Task exec sub-session (`…:task:<id>:exec:<execId>…`) | `AgentSession.createSessionFromInit` (`agent-session.ts:816`) with init from `resolveAgentInit` / `createCustomAgentInit` (`agents/custom-agent.ts:96`) | `{ type:'preset', append: resolveCustomAgentPrompt(agent, slotOverrides).value }` — agent instructions expanded with workflow slot `customPrompt` / `replaceAgentPrompt` (`agents/custom-agent-prompt.ts:43`) | preset + append → `snapshot: false` |
| GitHub security agent | one-shot `query()` per scan (`github/security-agent.ts:178`) | n/a (compiled-in constant, fresh process each run) | always current; out of scope |

Per-session overrides already have a persistence slot: `systemPrompt` is a `'carried'` config field
(`session/create-session-config.ts:19`), carried at creation, admitted at update
(`admitUpdateSessionConfig`, `create-session-config.ts:112`), and persisted in
`sessions.config` JSON by `SessionConfigHandler.updateConfig`
(`agent/session-config-handler.ts:22`). The RPC door can therefore already change a stored prompt —
there is simply no UI, no operation, and no guaranteed application to a live query.

## 2. How the prompt reaches the runtime each turn

Three layers, each with its own refresh cadence:

**Layer 1 — options are spawn-time.** `QueryOptionsBuilder.build()` runs inside
`QueryRunner.runQuery` (`agent/query-runner.ts:811`) when a query is *started*, not per user
message. The SDK serializes `systemPrompt` once in the `initialize` control request to the CLI
subprocess (verified in the pinned SDK `0.3.268` bundle: `sdk.mjs` initialize payload). A live
query keeps serving turns from those spawn-time options.

**Layer 2 — per-request render vs transcript record.** The pinned SDK's `snapshot` semantics
(`packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2203-2253`):

- *Omitted / `true` (default)*: the rendered prompt is recorded in the session transcript on the
  first request and replayed verbatim on every later request and every `resume`/`continue`; a
  different `append`/`prompt` on a later launch is **ignored until compaction or a new session**.
- *`false`*: never recorded; rendered fresh on every request, and the restore path is bypassed, so
  an already-recorded session picks up its current configuration at the next spawn.

HyperNeo sets `snapshot: false` (`RECORD_HOST_AUTHORED_PROMPT = false`,
`query-options-builder.ts:78`) wherever it supplies prompt text of its own. #4833 made that change
deliberately: "the daemon rebuilt the right prompt each turn and the CLI discarded it… because the
flag also bypasses the restore path, an already-recorded session picks up its current
configuration on its next turn — no restart, no lost history, no recreation." Bare-preset sessions
(no host text at all) intentionally keep the SDK recording — costs them nothing, keeps their cache
prefix stable.

**Layer 3 — dynamic parts recompute at every build.** `getSpaceBriefing()`
(`agent-session.ts:285`) re-assembles the briefing from the live space scope and attached
capabilities on every `build()`; worktree text is static per worktree. So briefing changes already
land at the next spawn without any config write.

**Net effect per kind.** For every kind that carries host-authored text, the prompt is *assembled
at request time from spawn-time options*: changing `session.config.systemPrompt` (or the agent
instructions behind it) has no effect on a query that is already running, and takes effect at the
next query spawn. Spawns happen at: session start, daemon restart rehydration, model switch
(`model-switch-handler.ts:527` → `lifecycleManager.restart`), long-horizon refresh
(`refreshLongHorizonAgentSessionConfig`, `space-runtime-service.ts:654`), `/clear`, context-reset
and error-recovery restarts. For bare-preset ordinary chats, additionally, the base prompt is
transcript-recorded — but the host authors nothing there, so there is nothing host-side to reload
until an override/append is added (which flips the session to `snapshot: false`, and per #4833 the
recorded copy is superseded from the next spawn).

ACP-provider sessions follow the same shape but a different transport: `AcpQueryRunner` extracts
the host-authored text (`systemPromptText`, `acp/acp-query-runner.ts:377`) and sends it as
`session/new` instructions at each spawn; the ACP agent owns its own base prompt. Restart applies
new text the same way.

## 3. Feasibility of the three candidate mechanisms

**(a) Next-turn re-injection without rewriting history — recommended, and already half-built.**
The write path is `session.updateConfig({ systemPrompt })` (persists + publishes
`session.updated`) followed by `resetQuery({ restartQuery: false })` + `restart()` — verbatim the
tail of `refreshLongHorizonAgentSessionConfig` (`space-runtime-service.ts:677-684`) and the same
restart `handleModelSwitch` performs. History is untouched: the CLI resumes via `sdkSessionId`
(`addSessionStateOptions`, `query-options-builder.ts:591-596`), so continuity, checkpoints and
compaction state survive. Precedents that prove each step in production: #4833 (snapshot bypass),
model switch (idle-restart), long-horizon refresh (config diff + restart).

**(b) In-place transcript rewrite — reject.** The SDK transcript is CLI-owned; nothing in the
pinned SDK offers prompt rewriting of a recorded conversation, and (a) makes it unnecessary.
Dangerous and unsupported, exactly as suspected.

**(c) Per-session stored override — keep, as the storage model for (a).** `config.systemPrompt`
already persists per session and is carried through `AgentSession.restore`. An override should be
stored as `{ type: 'preset', preset: 'claude_code', append: <text> }` rather than a bare custom
string: a bare custom string *replaces* the entire Claude Code base prompt (tools, conventions,
the works) and would gut an ordinary chat's behavior. The append shape preserves the base and only
adds host text — and automatically lands in the `snapshot: false` path.

## 4. Proposed API, evaluated

Mirror `session.runtimeSettings.*` (`session/runtime-settings-operations.ts`,
`runtime-settings-read-operation.ts`) — the ownership, gating, and result conventions all transfer
directly.

### `session.systemPrompt.read { sessionId }`

Reportable today for every kind: the stored `SystemPromptConfig` (override/append text), its
**source** — `builtin-preset` | `session-override` | `space-agent:<source>` (from
`resolveCustomAgentPrompt().source`) | `workflow-node` (from `metadata.promptProvenance`) |
`daemon-owned` (neo) — plus `live`, `queryActive`, `ownership`, reusing
`classifySessionOwnership` and the read deps. **Staleness** is computable where a source exists:
for Space agents compare `sha256(current resolved prompt)` against
`metadata.promptProvenance.hash` (`custom-agent-prompt.ts:63,84`); for long-horizon agents diff
the freshly built `buildAgentSessionConfig().systemPrompt` against the stored one (the exact diff
`refreshLongHorizonAgentSessionConfig` already computes); for ordinary/project chats staleness is
N/A (no source) unless an override exists. One honest caveat to state in the operation
description: the *fully rendered* prompt (preset base + dynamic sections) exists only inside the
CLI; the operation reports host-authored content and provenance, not the rendered base.

### `session.systemPrompt.update { sessionId, source?: "current" | override text }`

- **Refusal while busy** — reuse the `session_busy` / optimistic-snapshot gates from
  `runtime-settings-operations.ts:77-96` (`gateReady`: active, starting, queued, pending work,
  `isQueryActiveOrStarting()`). This is stricter than runtimeSettings needs to be for thinking
  level, and it is *required* here because the apply step restarts the query.
- **Apply** — `source: "current"` re-resolves the kind's current source (space agents: agent
  instructions; ordinary/project: clears any override back to the bare preset); an explicit
  override stores the append-shaped `SystemPromptConfig`. Then persist + restart the idle query so
  `appliesFrom: "next-turn"` is a guarantee rather than a hope. The CAS write can either extend
  `RuntimeSettingsPatch` with a `$.systemPrompt` json_set path
  (`session-runtime-settings-write.ts:50-55`) or reuse `updateConfig`; extending the existing
  snapshot guard is the smaller, race-safe delta.
- **Neo sessions (`neo:*`): refuse.** `restrictNeoQuery` unconditionally overwrites
  `options.systemPrompt` from the compiled-in `neoPrompt(concernId)` at every build
  (`neo/session-policy.ts:41`), so a stored override would be silently discarded. Their prompt
  source changes only with a daemon upgrade, and every daemon restart re-renders it anyway. The
  operation should say so (`reason: 'daemon_owned_prompt'`) rather than accept a no-op.
- **Space-task exec sessions: read-only in v1.** Their prompt is workflow-owned (node/slot/agent
  resolution). Reload for them belongs to the existing re-resolution points — spawn-attach
  (`task-agent-manager.ts:2277`), post-approval restore (`performPostApprovalWorkerRestore`), and
  rehydrate (`task-agent-manager.ts:3860`) already call `setRuntimeSystemPrompt` with freshly
  resolved init. A per-session override would fight the workflow; if needed later, add an
  explicit "re-resolve from workflow now" action instead.
- **Caller scope** — identical to runtimeSettings: Neo may target any session; MCP callers are
  admitted only within their own Space (`callerOwnsTarget`,
  `runtime-settings-operations.ts:48`).

### Interaction with `agent.update.customPrompt`

`agent.update` writes `agent.instructions` (`agents/update-agent-operation.ts:140`) — the *source*,
not a session. Precedence that matches the code today: **per-session override > agent source >
bare preset** (`resolveCustomAgentPrompt` puts slot overrides above agent instructions; a stored
session override sits above both because it replaces `config.systemPrompt` wholesale).

Does updating an agent auto-refresh its live session? **For long-horizon agents: yes, lazily.**
Every delivery to the agent resolves through `ensureAgentSession` → `ensureLongHorizonAgentSession`
(`session-resolution/resolve-delivery-session.ts`, `space-runtime-service.ts:702`), which rebuilds
the config from current instructions and applies it when it differs. It does *not* refresh
eagerly at `agent.update` time — an idle agent's next inbound message applies it. **For task exec
sessions: no** — agent/template edits reach live exec sessions only at the restore/rehydrate points
above. Recommendation: keep the lazy path (it is correct and already tested by use), document the
"applies at next message" semantics on `agent.update`, and let
`session.systemPrompt.update { source: "current" }` be the explicit, immediate form for
space-agent sessions.

## 5. Risks and costs

- **Prompt-cache invalidation + thinking discard.** The SDK doc: a system prompt that changes
  mid-conversation "invalidates the prompt prefix and, with extended thinking, discards the
  model's earlier reasoning". One-turn cost spike on reload; frequent reloads thrash the cache.
  The API should surface this in `notes` so callers batch prompt edits.
- **No context growth by construction.** Reload *replaces* the prompt; it does not append to the
  transcript. Growth risk only appears if someone misuses the mechanism to append escalating
  overrides — the append-shaped storage keeps one canonical text.
- **History/prompt divergence.** Turns already in the transcript were generated under the old
  prompt; the model sees new prompt + old history. That is the desired semantics for a
  "changed instructions" reload, but for radical role changes a fresh session or `/clear` is the
  better tool — `read` exposing `stale` lets the caller decide.
- **Mid-flight refusal is the safety property, not a limitation.** Restarting a query that is
  streaming a turn would abort in-flight work; refusing while `queryActive` mirrors runtimeSettings
  and keeps the guarantee cheap.
- **Bare-preset sessions flipping to recorded-vs-fresh.** Adding an append to a previously
  bare-preset chat moves it from SDK-recorded to `snapshot: false`. #4833 established the CLI
  honors the fresh render from the next spawn even for already-recorded sessions, so this is safe,
  but the prototype's acceptance test should pin it explicitly.
- **Recorded-prompt trap on non-first-party backends.** Per the SDK doc, on Bedrock / Vertex /
  Foundry `snapshot` "is accepted and has no effect" — prompts always render fresh, so reload is
  trivially fine there; the doc's warning applies only where recording is active, which is exactly
  the case `snapshot: false` opts out of.
- **Concurrent mutation.** Prompt writes must ride the same incarnation/snapshot CAS as
  runtimeSettings so a reload cannot interleave with a model switch or archival.

## 6. Recommendation and slicing (ADR 0004)

**Recommendation:** build mechanism (a) as an operations-door pair
`session.systemPrompt.read` / `session.systemPrompt.update` in
`packages/daemon/src/lib/session/` (register in `rpc-handlers/family-operations/session.ts`, names
in `packages/shared/src/types/operation-names/session.ts`), scope v1 to
`ordinary | project | space-agent` ownerships, refuse `neo` (daemon-owned) and `space-task`
(workflow-owned) with explicit reasons, and apply via persist + idle-restart. Storage: extend the
runtime-settings CAS patch with a `$.systemPrompt` path. No transcript writes anywhere.

Natural ladder, one slice each:

1. **Pin** — characterization tests: `buildSystemPrompt()` shapes per kind (string / preset+append /
   bare preset + snapshot flags), and the append-vs-bare-preset boundary for ordinary chats.
2. **Build** — the read operation (pure resolution + provenance/staleness) with tests; registered
   so knip sees it.
3. **Wire** — the update operation: gates, CAS write, `updateConfig` + `resetQuery` + `restart`
   tail; refuses `neo`/`space-task`.
4. *(optional follow-up)* — surface in web UI settings panel; eager refresh hook on
   `agent.update`.

**Smallest viable prototype** (if wanted as a throwaway): the update operation for **ordinary and
project chats only** — gate, store append-shaped override, restart idle query, return effective
prompt + `appliesFrom: 'next-turn'`. Every mechanism it needs already exists and is named above;
estimated well under the ~300-prod-line slice budget.

## Open questions

- Should `read` also return the CLI-rendered prompt when available (the SDK reports stored prompts
  via `getStoredPromptsByUuid`, `sdk-message-repository.ts:1863`), or keep to host-authored content
  + provenance? (Recommend the latter for v1; the rendered base includes dynamic sections that are
  not meaningfully diffable.)
- Should `source: "current"` on an ordinary chat with no override be a no-op success or
  `nothing_to_update` (runtimeSettings precedent: rejection)?
- Long-horizon agents: is lazy-at-next-message the desired contract forever, or should
  `agent.update.customPrompt` trigger the ensure-refresh eagerly when the session is idle?

## Sources

- `packages/daemon/src/lib/agent/query-options-builder.ts:78-82,682-755` — prompt assembly, snapshot flags
- `packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2203-2253` — `snapshot` semantics (pinned 0.3.268); `sdk.mjs` initialize payload (spawn-time delivery)
- Commit `654432e081` (#4833) — snapshot:false precedent and its stated next-turn semantics
- `packages/daemon/src/lib/agent/query-runner.ts:811` — build at query start; `query-lifecycle-manager.ts:443-541` — long-lived query, no idle teardown
- `packages/daemon/src/lib/neo/session-policy.ts:32-56`, `neo/service.ts:291-313,380-405` — neo prompt ownership
- `packages/daemon/src/lib/session-resolution/agent-session-config.ts:34-69,124-136` — long-horizon agent prompt source
- `packages/daemon/src/lib/space/runtime/space-runtime-service.ts:108-117,654-735,855-866` — existing refresh mechanism
- `packages/daemon/src/lib/space/runtime/task-agent-manager.ts:2277,3860` — exec-session re-injection points
- `packages/daemon/src/lib/agents/custom-agent.ts:60-120`, `custom-agent-prompt.ts:43-86` — task exec prompt resolution + provenance hash
- `packages/daemon/src/lib/session/runtime-settings-operations.ts`, `runtime-settings-read-operation.ts`, `storage/repositories/session-runtime-settings-write.ts` — operation/gate/CAS template
- `packages/daemon/src/lib/session/create-session-config.ts:19,112-131`, `rpc-handlers/session-handlers.ts:338` — `systemPrompt` already carried/admitted on the RPC door
- `packages/daemon/src/lib/agents/update-agent-operation.ts` — `agent.update.customPrompt` behavior
