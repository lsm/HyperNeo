# RPC namespace triage — what belongs behind the operations door

Companion to [`rpc-mcp-unification-current.md`](./rpc-mcp-unification-current.md),
[`rpc-mcp-unification-target.md`](./rpc-mcp-unification-target.md) and
[`rpc-mcp-unification-gap.md`](./rpc-mcp-unification-gap.md). Those describe the two ends of
the migration and the delta between them. This one supplies the **denominator**: which
MessageHub RPC namespaces are in scope for [ADR 0006](../adr/0006-shared-operations.md)'s
operations door, and which are not. Without it, "the door migration is finished" is not a
statement anyone can check.

Measured against `dev` @ `319964ec3` (2026-09-18) by scanning every `.onRequest(` call site in
`packages/daemon/src` — the whole package, not just `lib/rpc-handlers/` — and *resolving* the
method name rather than matching a string literal. That is 216 call sites, two of which are
not hub registrations: `lib/acp/acp-transport.ts:215` invokes an ACP transport option, and
`lib/external-events/extension-manager.ts:137` is the tracking proxy that forwards an
extension's own registration. The remaining 214 are the methods counted below.

To reproduce the count, a scan has to survive four registration forms. The first defeats a
line-anchored scan; the last three defeat any scan that reads the first argument as a string
literal. Each of the four has produced a wrong denominator at least once:

1. `messageHub.onRequest<Request, Response>(` with the method name on the **following line**.
   Parse across newlines or lose 30 methods.
2. Registrations **outside `rpc-handlers/`**. `space.github.*` is registered in
   `lib/external-events/github/github-event-extension.ts` (wired at `app.ts` and
   `rpc-handlers/index.ts`), `state.*` in `lib/state-projection-service.ts`.
3. A **constant** as the first argument. `state.*` registers through `STATE_CHANNELS.*`
   (`packages/shared/src/state-types.ts:173`), never as a literal.
4. A **file-local `method()` helper**. `space-agent-v2-handlers.ts`,
   `space-agent-template-handlers.ts`, `space-agent-subscription-handlers.ts` and
   `space-agent-reminder-handlers.ts` each build their names from a `METHOD_PREFIX` constant,
   so no literal scan sees any of their 18 methods.

## The three buckets

**Door-bound** — the capability is something an agent can or should invoke, so it belongs
behind `operation.invoke` with a declared policy. The test is the *capability*, not today's
caller: a handler with only a web caller today is still door-bound if an agent asking for the
same thing is a sensible request.

**Stays outside** — local UI affordance, transport, process lifecycle, or credential
handling, with no meaningful agent caller. These keep their RPC handler and are not counted
against the migration.

**Subscription plane** — `liveQuery` only. A subscription is a stream with a lifetime, not a
call/result contract, and it is not a door candidate in any form.

## Two things a door-bound verdict does not mean

**Door-bound is not policy enforcement.** `isOperationAdmitted`
(`packages/daemon/src/lib/operations/invoke.ts:52`) returns `true` immediately for any caller
whose `source` is not `'mcp'`, before it looks at the operation's policy at all. Moving a
handler behind the door therefore does *not* put web callers under its role or safety class
today. What door-bound buys is one implementation instead of two, an audit row, and the
operation's own scope logic — not a gate on the web path. Whether that changes is tracked
separately in #4718; nothing in this document assumes it will.

**The `liveQuery` authorization gap is known and is not fixed here.** `liveQuery.subscribe`
(`packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts:4390`) authorizes through an
`if`/`else if` ladder over `queryName` with no trailing `else`, so any query the ladder does
not name is subscribed with no check — including `sessions.list`, `skills.list`,
`mcpServers.global` and `nodeExecutions.byRun`. It is latent while the WebSocket transport
has no authentication, which it does not have today. Recorded here as a pointer only; it is
its own issue, and it is not a reason to move `liveQuery` into either other bucket.

## The count

**214 methods across 39 namespaces**, one of which (`operation.invoke`) *is* the door.

Two earlier figures were both too small, each missing a different one of the forms above.
148/30 came from a line-anchored scan (form 1) and hid 30 methods, including the whole
16-method `evolution` namespace, four of `auth`, three of `providers`, two of
`customEndpoints`, `settings.global.update`, `session.list`, `reference.resolve`,
`voice.transcribe` — and `operation.invoke` itself. 178/34 fixed that but still scanned only
string literals inside `rpc-handlers/` (forms 2–4) and hid 36 more: 15 `space.github.*`, 3
`state.*`, and the 18 methods of the four `spaceAgent*` namespaces.

| Bucket | Methods |
| --- | --- |
| Door-bound | 108 |
| Stays outside | 103 |
| Subscription plane | 2 |
| The door itself (`operation.invoke`) | 1 |

## Verdicts

`session` and `space` are genuinely mixed — `session` splits two ways and `space` three; the
per-method breakdown follows the table. Every other namespace takes one verdict.

| Namespace | Methods | Verdict | Reason |
| --- | --- | --- | --- |
| `evolution` | 16 | Door-bound | Near-1:1 duplicate of the 23-name `forge.*` family over the same scope and episode services (`lib/evolution/operations.ts`); the RPC copy is the second implementation ADR 0006 exists to remove. |
| `space` (reads, task messaging, runtime state) | 11 | Door-bound | Space reads, task-directed messages and node-agent activation are what a Space agent does; `space.task.sendMessage` already has `task.message.send` and `space.externalEvents.listDeliveries` already has `externalEvent.listDeliveries`. |
| `spaceGoal` | 11 | Door-bound | The `goal.*` family covers nine of the eleven and three already route through the door; goals are owned by long-horizon agents by design. |
| `spaceWorkflow` | 11 | Door-bound | `workflow.list`/`get` already exist; authoring, template sync and drift detection are the same capability agents already have for agent templates (`agentTemplate.*`). |
| `spaceWorkflowRun` | 9 | Door-bound | Run reads, commits and diffs are a reviewer agent's evidence and it has no other way to reach another worker's worktree; `workflow.run.get` and `artifact.list` already cover three of the nine. See the `approveHook` note below. |
| `taskSchedule` | 6 | Door-bound | The `schedule.*` family already matches all six one for one, name for name. |
| `spaceAgentV2` | 6 | Door-bound | The RPC copy of the `agent.*` family — list/get/create/update/delete over the same repository the operations use. `family-operations/agents.ts` already calls `publishSpaceAgentV2Mirror` so the door path feeds this namespace's event stream. |
| `agentMemory` | 5 | Door-bound | Space-scoped agent memory, already reachable by agents through the `agent-memory` MCP server — two doors onto one store is the exact duplication in scope. |
| `message` | 5 | Door-bound | `message.send` duplicates the registered `session.message.send`; the rest are transcript reads and FTS search, which is what an agent asks for when it needs a peer's history. |
| `skill` | 5 | Door-bound | Skills are authored instruction content, and an agent writing a skill from a Forge lesson is the loop this codebase already builds toward. |
| `session` (reads, transcripts, state) | 5 | Door-bound | `session.get`, `session.list`, `session.update` and `session.messages.byStatus` each have a counterpart in the `session.*` family; `session.export` is a transcript read like the `message` namespace. |
| `spaceAgentTemplate` | 5 | Door-bound | The RPC copy of `agentTemplate.*`; four of the five match name for name, and `listBuiltIn` is a subset of what `agentTemplate.list` already returns. |
| `spaceAgentSubscription` | 4 | Door-bound | Agent event subscriptions, which the `externalEvent.agent.*` family already owns — an agent choosing what it wakes up for is the capability those operations were declared for. |
| `spaceAgentReminder` | 3 | Door-bound | `agent.reminders.create` and `agent.reminders.list` already exist; durable reminders are how a long-horizon agent schedules its own next turn. |
| `spaceExport` | 2 | Door-bound | Bundling a space's agents and workflows is a space-scoped capability operating on JSON, not on local files; a provisioning agent is a real caller. |
| `spaceImport` | 2 | Door-bound | Same capability in reverse. `spaceImport.execute` writes agents and workflows from caller-supplied content and needs a restrictive safety class, which is a policy question, not a bucket question. |
| `client` | 1 | Door-bound | `client.interrupt` is a second implementation of the already-registered `session.interrupt`. |
| `nodeExecution` | 1 | Door-bound | `workflow.run.get` already returns the run with its node executions. |
| `session` (runtime, worktree, drafts) | 23 | Stays outside | Model/thinking/sandbox/coordinator switching, worktree creation and removal, rate-limit retry control, voice drafts and the SDK resume prompt drive an in-process `AgentSession` and local disk for one watching human. |
| `space.github` (event-source config) | 15 | Stays outside | Per-space configuration of the GitHub ingress — enabling the source, storing and clearing a PAT, choosing watched repos, installing webhooks, polling toggles — behind `SpaceExternalEventsSettings.tsx` and `GitHubHealthPanel.tsx`. It is the per-space twin of the `externalEvents` row plus the credential handling of `providers`/`auth`, and it carries the same self-grant objection as `mcp`: widening your own event intake is not a capability. What comes *out* of the ingress is already door-bound (`externalEvent.listDeliveries`, `externalEvent.agent.subscribe`). |
| `space` (lifecycle, workspace registry, MCP overrides) | 9 | Stays outside | Creating, deleting and archiving spaces, registering local repo paths, and raising the autonomy ceiling via `space.update` are operator acts; an agent widening its own autonomy or toolset is escalation, not a capability. |
| `mcp` | 8 | Stays outside | The MCP registry and its per-scope enablement decide which executable tool servers an agent gets. Granting yourself a capability is not a capability. |
| `providers` | 8 | Stays outside | Provider rows plus keychain writes, OAuth token storage and live provider probes. |
| `auth` | 6 | Stays outside | OAuth login, callback submission, refresh and logout against the keychain. |
| `customEndpoints` | 5 | Stays outside | Global settings-file writes plus outbound model-list fetches carrying the caller's API key. |
| `rewind` | 4 | Stays outside | Checkpoint preview and revert over an in-process session's ledger and its worktree files — a human undo affordance on a session someone is watching. |
| `git` | 3 | Stays outside | Branch, status and diff reads for the UI's diff viewer; an agent already sits in the worktree with its own tools. (Contrast `spaceWorkflowRun`, where the caller is outside the worktree being read.) |
| `state` | 3 | Stays outside | Transport, not capability. `state.global.snapshot`, `state.session` and `state.sdkMessages` are the request half of a push channel: `StateChannel` (`packages/web/src/lib/state.ts`) fetches a baseline over `hub.request` and then takes deltas over `hub.onEvent` on the same channel name. Every payload they return is already reachable through `session.get`, `session.list` and `session.messages.list`. |
| `question` | 3 | Stays outside | Resolves a live session's pending `AskUser` tool-use id — the human half of a human-in-the-loop prompt. Agent-to-agent answering goes through task messaging instead. |
| `workspace` | 3 | Stays outside | The recent-folders list behind the new-session picker. |
| `externalEvents` | 2 | Stays outside | Global enable/disable of a daemon-wide event source extension; per-space delivery reads live under `space.externalEvents` and are door-bound. |
| `reference` | 2 | Stays outside | Backs `@`-mention autocomplete in the composer over a file index; agents read files with their own tools. |
| `voice` | 2 | Stays outside | Audio transcription through a keychain-stored credential. |
| `dialog` | 1 | Stays outside | `dialog.pickFolder` spawns an OS folder picker on the daemon host. |
| `globalTools` | 1 | Stays outside | Read of the global tool-permission config. |
| `models` | 1 | Stays outside | Provider model catalog; probes stored credentials to build it. |
| `settings` | 1 | Stays outside | Writes the global settings file and moves the voice API key into the keychain. |
| `system` | 1 | Stays outside | Daemon health and uptime. |
| `tools` | 1 | Stays outside | Per-session tool allowlist — the same self-grant objection as `mcp`. |
| `usage` | 1 | Stays outside | Cost and token aggregates for the local usage dashboard. |
| `liveQuery` | 2 | Subscription plane | Subscribe/unsubscribe with a per-client lifetime and delta delivery; not a call/result contract. |
| `operation` | 1 | — | `operation.invoke` is the door. |

### `session`, method by method

Door-bound (5): `session.get` → `session.get`, `session.list` → `session.list`,
`session.update` → `session.state.update`, `session.messages.byStatus` →
`session.messages.list`, and `session.export`, which renders a stored transcript and belongs
with the `message` reads.

Stays outside (23): `session.create`, `session.delete`, `session.archive`,
`session.setWorkspace`, `session.setWorktreeMode` (DB row plus a git worktree on disk);
`session.model.get`, `session.model.switch`, `session.thinking.get`, `session.thinking.set`,
`session.sandbox.switch`, `session.coordinator.switch`, `session.resetQuery`,
`session.sdkResumeChoice` (mutate or restart the in-process SDK query);
`session.cancelRateLimitRetry`, `session.retryNowAfterRateLimit` (in-memory timers);
`session.appendVoiceDraft`, `session.clearInputDraftIf` (composer drafts);
`session.messages.removePending`, `session.messages.deferPending`,
`session.messages.promotePending`, `session.messages.retry` (outbox controls for the human
watching the queue); `session.listRuntimeMcpServers` and `session.mcp.list` (capability
config, per the `mcp` row).

### `space`, method by method

Door-bound (11): `space.overview`, `space.listWithTasks`, `space.workspace.list`,
`space.task.sendMessage` (has `task.message.send`), `space.task.activateNodeAgent`,
`space.externalEvents.listDeliveries` (has `externalEvent.listDeliveries`),
`space.externalEvents.queueHealth`, `space.start`, `space.stop`, `space.pause`,
`space.resume`.

Stays outside (24): `space.create`, `space.delete`, `space.archive`, `space.update` (autonomy
ceiling and concurrency limits), `space.workspace.add`, `space.workspace.remove`,
`space.workspace.updateLabel` (registers local repo paths), `space.mcp.setEnabled`,
`space.mcp.clearOverride`; and the 15 `space.github.*` methods, all registered in
`lib/external-events/github/github-event-extension.ts` rather than in `rpc-handlers/`:
`enable`, `disable`, `setToken`, `clearToken`, `getTokenStatus`, `watchRepo`, `unwatchRepo`,
`listWatchedRepos`, `listConfig`, `autoConfigureWebhook`, `checkWebhook`, `setPollingEnabled`,
`setFilterCurrentUser`, `pollOnce`, `health`. The three read-only ones — `listConfig`,
`listWatchedRepos`, `health` — are the closest of the fifteen to a door case, and are filed
outside with the rest of their namespace for the same reason `mcp`'s reads are.

### The four `spaceAgent*` namespaces, method by method

All 18 are door-bound, and the reason is the same for every one of them: each is a second
implementation of an operation family that already exists, registered under a different name.
The duplication is already load-bearing — `family-operations/agents.ts` calls
`publishSpaceAgentV2Mirror` on the operation path, so a create through the door has to reach
back into this namespace's event stream to keep the web UI consistent.

| RPC method | Operation it duplicates |
| --- | --- |
| `spaceAgentV2.list` | `agent.list` |
| `spaceAgentV2.get` | `agent.get` |
| `spaceAgentV2.create` | `agent.create`, and `agent.createFromTemplate` when a template key is supplied |
| `spaceAgentV2.update` | `agent.update` |
| `spaceAgentV2.delete` | `agent.archive` — the family has no hard delete, the RPC copy does |
| `spaceAgentV2.listReminderCounts` | `agent.reminders.list`, tallied per agent |
| `spaceAgentTemplate.list` | `agentTemplate.list` |
| `spaceAgentTemplate.listBuiltIn` | `agentTemplate.list`, which already returns built-ins alongside space-owned rows |
| `spaceAgentTemplate.create` | `agentTemplate.create` |
| `spaceAgentTemplate.update` | `agentTemplate.update` |
| `spaceAgentTemplate.delete` | `agentTemplate.delete` |
| `spaceAgentSubscription.list` | `externalEvent.agent.listSubscriptions` |
| `spaceAgentSubscription.create` | `externalEvent.agent.subscribe` |
| `spaceAgentSubscription.delete` | `externalEvent.agent.unsubscribe` |
| `spaceAgentSubscription.update` | No counterpart; the family expresses an edit as unsubscribe plus subscribe |
| `spaceAgentReminder.listCounts` | `agent.reminders.list`, tallied per agent |
| `spaceAgentReminder.create` | `agent.reminders.create` |
| `spaceAgentReminder.delete` | No counterpart; the family has create and list only |

The three rows with no counterpart are gaps in the operation families, not reasons to leave
the namespace outside — they are what the door migration has to add.

## Notes on individual verdicts

- **`spaceWorkflowRun.approveHook`** is door-bound as a capability but is the clearest
  candidate in this list for a `human_only` safety class: a worker approving its own gate
  defeats the gate. The door is where that can be declared; today's handler cannot express it.
- **`skill` versus `mcp`.** Both configure what an agent can do, and they land in different
  buckets on purpose. A skill is authored instruction content; an MCP server is an executable
  endpoint, often with credentials. Authoring content is a capability; granting yourself an
  executable endpoint is escalation.
- **`git` versus `spaceWorkflowRun` diffs.** Same underlying reads, different callers. An
  agent inside a worktree reaches its own repo with Bash; a reviewer agent cannot otherwise
  read the commits and diffs of a run it did not execute.
- **Operation families with no RPC surface at all.** `artifact.*`, `audit.*` and `node.*`
  exist only as operations. They are already on the far side of the door and are not counted
  here. `agent.*`, `agentTemplate.*`, `externalEvent.agent.*` and `agent.reminders.*` are
  **not** in that group, despite an earlier revision of this document saying so: their RPC
  twins are the four `spaceAgent*` namespaces above, which the `space-agent-*-handlers.ts`
  files register as `onRequest` methods through a `METHOD_PREFIX` helper rather than as
  operations. That error is what made the first count 36 methods short.

## Where the verdicts are least certain

Four calls could reasonably go the other way, and would change the denominator by 11 methods:

- **`spaceImport` / `spaceExport` (4)** — called door-bound. The counter-argument is that
  both exist to serve a browser download/upload flow and have never had another caller.
- **`skill` (5)** — called door-bound on the strength of agent-authored skills, which is a
  direction this codebase is heading rather than something it does today.
- **`question` (3)** — called stays-outside. A supervising agent answering a worker's
  question is a coherent autonomy feature; the handler is simply bound to a live session's
  tool-use id right now.
- **`rewind` (4)** — called stays-outside for the same reason, and would move if rewinding a
  stuck worker ever becomes a supervisor's job.

`usage.calculate` is a near-miss in the other direction: it is a read-only aggregate that a
budget-aware long-horizon agent would plausibly want, filed outside because its only consumer
is the local dashboard.

## References

- ADR 0006: [`docs/adr/0006-shared-operations.md`](../adr/0006-shared-operations.md)
- Operation name families: `packages/shared/src/types/operation-names/` (13 files)
- Family registrars: `packages/daemon/src/lib/rpc-handlers/family-operations/`
- Admission short-circuit: `packages/daemon/src/lib/operations/invoke.ts`
- `liveQuery` authorization ladder: `packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts`
