# RFC: Data-Defined Workflow Engine

Status: Proposed — Revision 2 (Phase 0, architecture only; no runtime changes).
Incorporates design-review feedback (PR #2396): human-reviewer doc-accuracy fixes
and the codex-connector inline review, all claims re-verified against the code.
Date: 2026-08-07. Tracks goal task #874. Companion: `docs/adr/0003-data-defined-workflow-engine.md`.

## 1. Goal and non-goals

### Goal

Evolve HyperNeo's Space workflow system into a **domain-agnostic, durable execution
framework** suitable for business processes, manufacturing, ecommerce, personal-assistant
workflows, and agent collaboration — without a big-bang rewrite.

The foundational rule, in one line:

> **Data-defined behavior, code-defined semantics, plugin-defined capabilities.**

- **Data-defined behavior** — every workflow-specific behavior (topology, transitions,
  prompts, policies, approval thresholds, delivery targets, timers) lives in an immutable,
  versioned **definition** that the kernel interprets. The kernel never branches on
  *which* workflow is running.
- **Code-defined semantics** — the generic kernel owns the *meaning* of transitions,
  durability, leases, idempotency, approvals, timers, delivery, recovery, audit, and
  terminal states. These semantics are universal and not parameterized by domain.
- **Plugin-defined capabilities** — domain actions (call GitHub, call an ERP, book a
  flight, run a validator) are **connectors** registered into a generic capability
  registry. The kernel invokes them by id; it does not know what they do.

### Non-goals (this RFC)

- Implementing runtime changes. Phase 0 is design + approval only.
- BPMN/BPEL parity. We adopt patterns incrementally as reference workflows demand them.
- A visual designer or external format import.
- Distributed multi-process execution now. We design the seams (leases, fencing) but keep
  a single-process daemon until a measured bottleneck forces scaling.
- Deciding the fate of the two overlapping goal models. `goals`/`mission_executions` is an
  **active** Mission System (§7), not legacy; unifying it with `space_goals` is a separate
  investigation deferred past this RFC (Phase 7 re-scoped).

### Why this is tractable now

The current engine is already largely data-defined. A code survey confirms:

- There is **no `switch(workflowType)` or `switch(nodeType)` dispatch** in the core runtime.
  Topology (nodes/channels/gates/hooks/post-approval), gate evaluation, cycle caps,
  completion detection, and post-approval routing are all data-driven.
- A clean **connector abstraction already exists** (`packages/daemon/src/lib/space/runtime/connectors/`)
  with a generic registry (`Connector` / `ConnectorOp` / `ConnectorOutcome` /
  `ConnectorAuth`), a predicate DSL (`predicate.ts`), and validator presets.
- The connector layer is being rolled out **behind a feature flag**
  (`isConnectorsLayerEnabled()`, gated in `hook-executor.ts`).

So this is **not a rewrite**. It is a bounded extraction **plus** closing durability seams
that single-process execution let us defer. The remaining work is larger than "extract
GitHub" alone: several durability guarantees the goal demands (transactional outbox,
durable retry deadlines, append-only transition audit, deletion-safe versioning, mutating-
connector idempotency) are **not yet met** by the current code. Those gaps are enumerated
in §6 and drive new phases in §9.

## 2. Canonical concepts

We adopt the existing vocabulary wherever it is already correct — a parallel rename would
violate the incremental, compatibility-first constraint. New terms are introduced only
where the current model conflates or omits something.

| Canonical term | Current implementation | Notes |
|---|---|---|
| **Definition** | `SpaceWorkflow` (`packages/shared/src/types/space.ts:2419`) | Becomes **immutable + versioned + deletion-safe** (§4). |
| **Run** | `space_workflow_runs` row (`migrations.ts:2713`) | One execution of a definition. *(target: pins `definition_version`; today re-reads the live workflow row each tick — §4)* |
| **Work item** | `node_executions` row (`migrations.ts:5912`) | Statuses: `pending\|in_progress\|idle\|waiting_rebind\|blocked\|cancelled`. **Terminal = `idle` \| `cancelled`** (there is no `done`; a successful turn becomes a reactivatable `idle` row). |
| **Attempt** | (implicit: crash-retry-with-counting in tick loop) | **New, append-only**: an execution attempt of a work item. |
| **Token / activation** | `ChannelRouter.activateNode` creating `node_executions` | A channel-directed `send_message` or a gate-open *activates* a downstream node (see "advances state" below). |
| **Gate** | `Gate` + `gate_data` + `gate_open_state` | Declaration in definition; runtime state in `gate_data`; open-cache in `gate_open_state`. |
| **Channel** | `WorkflowChannel` (`space.ts:2215`) | Directed message pipe `from → to`, optional `gateId`, `maxCycles`. |
| **Approval** | Gate with `requiredLevel` / external `writers: []` field + `completionAutonomyLevel` | Human or autonomy-gated sign-off. |
| **Delivery** | `pending_agent_messages` (inbox) + `AgentMessageRouter` (outbox) | Durable **only for inactive targets** today; live targets bypass the inbox (§6.1–6.2 gap). |
| **Timer** | `task_schedules` (cron/at) + `GatePoll` (interval) + hook retry timers | Connector/gate **retry deadlines are in-memory only** today (§6.3 gap). |
| **Connector / capability** | `connectors/` registry + validator presets | Domain actions behind an id. Read-only ops are safe today; **mutating ops need command idempotency** (§5 gap). |
| **Task** | `space_tasks` | User-facing unit; 1:1 with a run via `workflow_run_id`. Sole completion source of truth. |
| **Goal** | `space_goals` **and** `goals`/`mission_executions` (both active) | Two overlapping models; unification deferred (§7, Phase 7). |
| **Worker** | A Space agent session | Agents/humans/services are workers; sessions are execution *resources*, not identity. |

**Mental model.** A *Goal* says *what* to achieve and *when* (trigger layer). It creates a
*Task* and a *Run* of a *Definition*. The kernel drives the run by *activating work items*
along *channels*, respecting *gates*. Workers pick up work items, emit *outcomes*, and the
kernel transitions the run deterministically. *Connectors* provide domain actions. Delivery
is durable and idempotent so workers can crash, retry, and recover without losing or
duplicating work.

### What advances process state

> **Channel-directed sends and explicit outcomes/commands advance process state;
> untargeted free text only communicates.**

A `send_message` **on a declared channel** is itself a structured activation command — it
carries `from → to` topology and is gated, and the kernel's `ChannelRouter.deliverMessage`
lazily activates the target node, advances cyclic-channel state, and can reopen a run.
Existing workflows rely on this for handoffs. Therefore the invariant is **not** "a message
never moves the graph"; it is: only *channel-directed* sends and *structured outcomes*
(gate writes that open a gate; terminal work-item outcomes; commands like
`submit_for_approval`/`approve_task`/`mark_complete`; timer fires) advance state. Untargeted
broadcasts (`*`) and free text do not. This matches current behavior — we preserve it
rather than migrate to a separate activation command.

## 3. Lifecycle / state-transition tables

These are the executable transition tables the kernel enforces, encoded as data (the
`VALID_NODE_EXECUTION_TRANSITIONS` pattern at `node-execution-manager.ts:39` is the model).
Where the existing set already matches, the table is a formalization; differences are
called out.

### 3.1 Run lifecycle

A run is **terminal** (`done`/`cancelled`) only when the canonical task is terminal **and**
any post-approval route has finished. `reportedStatus` being set is a **completion request**,
not a terminal state — the run must not be treated as terminal (for leases, timers,
activation, or delivery) while approval or post-approval work is still in flight.

| from | event | to | guard | side effect |
|---|---|---|---|---|
| `pending` | start node activated | `in_progress` | definition resolvable at pinned version | stamp `definition_version` |
| `in_progress` | `reportedStatus` set / `CompletionDetector.isComplete` | **`completing`** (nonterminal) | task not yet terminal | resolve through approval gate (§3.6); do **not** release leases / stop timers yet |
| `completing` | task → `done`/`cancelled` AND post-approval resolved | `done`/`cancelled` | terminal | release leases, stop timers, cancel pending delivery |
| `in_progress` | all work items terminal, no completion signal, restart | `blocked` | recovery pass | `failure_reason = 'agentCrash'` |
| `in_progress` | human reject | `blocked` | `failure_reason = 'humanRejected'` | — |
| `in_progress` | max iterations / node timeout | `blocked` | `failure_reason ∈ {maxIterationsReached, nodeTimeout}` | — |
| `in_progress`/`blocked` | human cancel | `cancelled` | — | cascade-cancel work items, release leases |
| `blocked` | manual restart / recovery claim | `in_progress` | work item re-activated | — |

`done`, `cancelled` are terminal. `blocked` is recoverable. `completing` is a nonterminal
held state (the run is still live for approval/merger). Today the engine reaches `done`
through the tick's `resolveTaskApproval` after `CompletionDetector` fires; we make the
nonterminal window explicit so durability consumers do not short-circuit early. Re-entrant
finalization short-circuits on `task.status === 'done'` (no separate stamp —
`completion_actions_fired_at` was dropped in M104).

### 3.2 Work item lifecycle

Matches `NodeExecutionStatus` (`space.ts:1111`): `pending | in_progress | idle |
waiting_rebind | blocked | cancelled`. **Terminal = `idle | cancelled`**
(`TERMINAL_NODE_EXECUTION_STATUSES`, `node-execution-manager.ts:67`). There is **no `done`**;
a successful turn parks as a reactivatable `idle` row.

| from | event | to | guard | side effect |
|---|---|---|---|---|
| `pending` | worker claims | `in_progress` | lease acquired (§6.3), idempotent activation short-circuit | append attempt #1 |
| `in_progress` | worker emits terminal outcome | `idle` | — | release lease (reactivatable) |
| `in_progress` | worker needs peer input | `waiting_rebind` | — | lease continues or parks |
| `in_progress` | gate blocks downstream | (self unchanged) | — | downstream not activated |
| `waiting_rebind` | input arrives / wake | `pending` | budget remaining, not terminal | append attempt #N, backoff |
| `in_progress`/`idle` | worker crash / lease expiry | `pending` (retry) | budget remaining | append attempt #N |
| `in_progress`/`idle` | timeout | `pending` (retry) | budget remaining | append attempt #N |
| `idle` | run cancelled | `cancelled` | — | release lease |
| retry exhausted | max attempts reached | `blocked` | — | run → `blocked` (`agentCrash`) |

**Phase 4 caveat (verified):** because the real lifecycle is idle/reactivation-based (not
`done`-then-retry-from-`in_progress`), Phase 4 cannot "merely append attempt records without
changing observable behavior." It must preserve the idle/reactivation semantics and either
model attempts against the existing statuses or include a tested status reconciliation.
This is acknowledged in the Phase 4 scope.

### 3.3 Gate lifecycle

| from | event | to | notes |
|---|---|---|---|
| `closed` | writer writes field / script runs / validator runs | re-evaluated | all fields pass → `open` |
| `closed` | autonomy threshold not met and validation passes | `pending_approval` | task → `review`; surfaces in UI |
| `closed` | autonomy threshold met and validation passes | `open` | auto-approval |
| `pending_approval` | human approves | `open` | — |
| `pending_approval` | human rejects | `closed` (or run `blocked`) | `resetOnCycle` may clear data |
| `open` | gate opens | activates downstream work items via `onGateDataChanged` | — |
| `open` | new cycle (cyclic channel) | `closed` | `channel_cycles++`, `gate_data` reset if `resetOnCycle` |

Gate open-cache (`gate_open_state`) is persisted across restart with a staleness guard
(`opened_workflow_updated_at`) — preserved as-is.

### 3.4 Delivery (inbox/outbox) lifecycle — target

| from | event | to | notes |
|---|---|---|---|
| `pending` | target worker activates | `delivered` | `flushPendingMessagesForTarget`, idempotent by `idempotency_key` |
| `pending` | TTL elapsed, attempts < max | `pending` (retry) | backoff |
| `pending` | max attempts reached | `failed` | actionable terminal failure surfaced |
| `pending` | run/work item terminal | `failed` | do not deliver to dead workers |

**Gap (§6.1–6.2):** today only *inactive* targets get a durable inbox row; **live targets
are delivered directly with no durable row**, so a crash between the state transition and
live delivery loses the handoff. The target state above is the goal; reaching it is the
transactional-outbox phase.

### 3.5 Timer lifecycle — target

| type | trigger | effect |
|---|---|---|
| schedule (`task_schedules`) | cron / `run_at` reaches `next_run_at` | enqueue fire job → new run/task instance |
| gate poll (`GatePoll`) | `intervalMs` tick while run `in_progress` | run gate script; if stdout changed, inject message |
| hook retry (`WorkflowHookRetrySettings`) | `next_retry_at` | re-run hook with backoff |
| **connector/gate retry** (`GateRetryScheduler`) | `retryAfterMs` | re-evaluate gate after backoff |

**Gap (§6.3):** `GateRetryScheduler` stores `retryAfterMs` in an in-memory `Map` +
`setTimeout` (`gate-retry-scheduler.ts:10-11,34`). A daemon restart loses the deadline, so a
rate-limited non-polled gate can stay closed indefinitely. Persisting these deadlines is a
durability phase.

All timers stop on run terminal state (but not before — see §3.1 `completing`).

### 3.6 Approval lifecycle

| from | event | to | guard |
|---|---|---|---|
| work item emits `submit_for_approval` | command accepted | task `review` | `space.autonomyLevel < completionAutonomyLevel` → human gate; else auto |
| task `review` | human `approve` | `approved` → post-approval route | double-fire guard (`postApprovalSessionId` set + alive → no-op) |
| task `review` | human `reject` | `in_progress` (feedback to worker) | — |
| `approved` | post-approval route done | `done` | `mark_complete` |

## 4. Workflow-definition schema (immutable, versioned, deletion-safe)

**Problem today.** Definitions are mutable (`SpaceWorkflowManager.updateWorkflow`) and only
soft-version-tracked via `templateHash` + `updatedAt`. Node IDs are stable
(`validateStableNodeIds`) but a definition edit can silently change the behavior of an
*in-flight* run, because runs re-read the live workflow row each tick. Separately,
`space_workflow_runs.workflow_id` is `ON DELETE CASCADE` and `deleteWorkflow`
(`space-workflow-manager.ts:445`) has **no active-run guard**, so deleting a definition
erases the supposedly-pinned in-flight run and its execution history.

**Decision (design review + verification).**

1. Version = an **in-row content hash** (`definition_version`) stamped on the definition
   row **and pinned on the run** at start, with prior versions retained in an append-only
   **`space_workflow_definition_versions`** history table. In-row (not a separate
   current-version table) avoids indirection on the ~15 hot-path `getWorkflow` reads per
   tick. Existing runs read their pinned version; new runs get the latest.
2. Built-in template re-stamping (`seedBuiltInWorkflows` hash-drift merge) becomes
   version-bumping rather than in-place mutation of live behavior.
3. **Deletion safety (verified gap):** Phase 1 must also make definition deletion safe for
   pinned runs — either **tombstoned (soft-deleted) definitions** or **version-level foreign
   keys** that retain every version referenced by a run, **plus an active-run guard** in
   `deleteWorkflow` (refuse or cascade-cancel cleanly). The current `ON DELETE CASCADE` on
   `workflow_id` must be removed or redirected to the version. Includes an explicit deletion
   migration + test.
4. The shape of `SpaceWorkflow` is otherwise unchanged — versioning + deletion-safety are
   wrappers, not a schema redesign. Existing readers keep working; they resolve through the
   pinned version.

**Reference definition schema** (TypeScript-ish, abbreviated — matches current
`SpaceWorkflow`):

```ts
interface WorkflowDefinition {
  id: string;                       // definition id (stable across versions)
  definitionVersion: string;        // content hash; immutable once published
  name: string;
  startNodeId: string;
  endNodeId?: string;

  nodes: Node[];                    // groups of agent slots; parallel execution
  channels: Channel[];              // directed from→to, optional gateId, maxCycles
  gates: Gate[];                    // fields | script | validator | features | poll
  hooks?: Hook[];                   // validators on MCP calls / runtime events

  completionAutonomyLevel: AutonomyLevel;   // self-close vs human review
  postApproval?: PostApprovalRoute;          // node-level routes
  runtimeContextContract?: RuntimeContextKey[]; // §7 — replaces implicit pr_url

  tags?: string[];                  // workflow-selector hints (default, v2, …)
}

interface Node {
  id: string; name: string;
  agents: NodeAgent[];              // slots: agentId, model, prompt, toolGuards, timeoutMs, …
  gateFeatureOverrides?: Record<string, unknown>; // §7 — replaces requireCodexApproval
  postApproval?: PostApprovalRoute;
}
```

Definitions are **declarations**; the kernel interprets them. Adding a domain (ecommerce,
manufacturing, travel) means authoring a definition + registering connectors — **zero
kernel changes**.

## 5. Capability / connector contract

The contract is sufficient for today's **read-only** external-state lookups. It is
**not yet sufficient for mutating operations** the reference workflows need
(`issueRefund`, `restockItem`, `book`).

```ts
type ConnectorOutcome =
  | { ok: true; data: unknown }
  | { ok: false; error: string; retryable?: boolean; retryAfterMs?: number };

type ConnectorOp = (params: unknown, ctx: ConnectorContext) => Promise<ConnectorOutcome>;

interface Connector {
  readonly id: string;                       // 'github', 'shop', 'mes', 'travel', …
  readonly ops: Record<string, ConnectorOp>; // 'getPr', 'createReturn', 'fileDefect', …
  readonly auth?: ConnectorAuth;             // env-injected secrets
}
```

**Gap (verified):** neither `ConnectorContext` nor `ConnectorOp` carries a stable command
idempotency key or a way to reconcile an unknown outcome. A crash after the remote service
succeeds but before the SQLite transition commits would let recovery issue a **duplicate**
refund or booking.

**Decision:** before any mutating connector ships, extend the contract with:
- a **command idempotency key** on `ConnectorContext` (derived from the run/work-item +
  step + attempt) so connectors can de-duplicate against the remote system, and
- **reconciliation semantics** for unknown outcomes (a connector must be able to answer
  "did this command already take effect?" so recovery can confirm rather than blindly retry).

Read-only connectors are unchanged. This is gated behind a "mutating-connector readiness"
phase; the reference workflows that mutate (ecommerce refund, travel booking) depend on it.

- **Registry**: `registerConnector` / `getConnector` / `isRegisteredConnector` /
  `getRegisteredConnectorIds`.
- **Validator layer**: a gate `validator: { kind: 'built_in', id }` composes a connector op
  + a predicate (`eq`/`empty`/`all`/`any`).
- **Domain packs**: `github` (existing: `getPr`, `getPrReadiness`, `getReactions`,
  `getReviewEvidence`; presets `pr_ready`, `pr_merged`, `review_posted`, `codex_review_bot`);
  `shop`, `mes`, `travel` (new reference).

The kernel calls connectors by id+op. Outcomes are typed `ConnectorOutcome` so retryability
and rate-limit backoff (`retryAfterMs`) are first-class — but the consumer of `retryAfterMs`
(`GateRetryScheduler`) must persist the deadline (§3.5/§6.3).

## 6. Durability, transaction, and recovery model

### 6.1 SQLite command transaction boundary (target + verified gap)

**Target:** every state transition is a single SQLite transaction that atomically (1)
validates the guard (CAS-style `WHERE current_status = ?`), (2) writes the new status +
append-only attempt/transition row, (3) **enqueues every resulting delivery in the same
transaction** (transactional outbox), (4) releases/acquires leases, and (5) persists any
retry deadline.

This is the existing pattern for *one* transition (`db.transaction()` for atomic
cycle-increment + gate-data-reset, `channel-router.ts:1752`). **Gap:** it is not the pattern
for delivery. Today `send_message` commits the gate write (`gateDataRepo.merge`) and only
then awaits `AgentMessageRouter.deliverMessage`; **live targets are delivered directly
without a durable row** (only inactive targets hit `pending_agent_messages`). A daemon crash
in that gap opens the gate but loses the handoff. The rule "never split a transition's write
from its outbox enqueue" is therefore a **new** requirement with its own phase — the current
delivery system is explicitly *not* "correct and untouched."

### 6.2 Inbox / outbox

- **Outbox** (within the transition transaction): every resulting delivery persisted before
  commit. `AgentMessageRouter` becomes the outbox dispatcher that drains rows for both live
  and inactive targets.
- **Inbox** (`pending_agent_messages` for node-agents; `space_agent_inbox_messages` for
  long-horizon agents): durable queues drained on worker activation. Today only the
  inactive-target path writes here; the outbox phase unifies live + inactive.
- **Idempotency**: `idempotency_key` unique partial indexes on both inboxes. Activation is
  idempotent (`activateNode` short-circuits on existing active executions).

### 6.3 Leases / fencing + durable retry deadlines

Today there is **no lease or fencing token**, and connector/gate **retry deadlines are
in-memory** (`GateRetryScheduler`, `gate-retry-scheduler.ts:10-11,34`). Both are durability
gaps.

**Decision (designed now; flag-gated / required when distributed):**

- A worker **claims** a work item by acquiring a lease row
  `work_item_leases(work_item_id, owner, fencing_token, expires_at)` in the same transaction
  that sets `in_progress`. A monotonic **fencing token** invalidates stale claims.
- Leases are **refreshed on real progress** (SDK message stream tick) so slow-but-alive work
  is not falsely retried — directly addressing the recurring stranded-delivery class
  (tasks #859–#862).
- **Durable retry deadlines**: connector/gate `retryAfterMs` is persisted to the timer/job
  model (a `gate_retries` row or `job_queue` entry keyed by `(run_id, gate_id)`) and
  rehydrated or cancelled on restart. This is required for the recovery guarantees in §6.5
  and is **not** flag-gated (a lost deadline silently strands a gate).

### 6.4 Append-only attempts and transition audit (verified gap)

- **Attempts** (`node_execution_attempts`, new): one row per execution attempt of a work
  item — `work_item_id`, `attempt_number`, `owner`, `started_at`, `ended_at`, `outcome`,
  `failure_reason`. Retries append; nothing mutates history.
- **Transition audit (gap):** `workflow_run_artifacts` are **upserts**
  (`UNIQUE(run_id, node_id, artifact_type, artifact_key)`, `migrations.ts:6514`), not
  append-only; hook-result artifacts cover only hook evaluations; attempts cover only
  work-item attempts. None records every run/task status change, approval, cancellation,
  gate reset, or routing transition. So the prior claim "every transition is reconstructable
  from append-only tables" was wrong. **Decision:** add an append-only
  **`workflow_transition_log`** (run/task status changes, approvals, cancellations, gate
  resets, routing transitions, with actor + command metadata), or explicitly narrow the
  audit guarantee to "work-item attempts + typed outputs" and adjust recovery accordingly.
  The full audit table is recommended for a durable execution framework.

### 6.5 Recovery

`SpaceRuntimeService.start()` chains recovery today (long-term inbox →
`recoverStalledRuns`): skip if work is in flight, finalize if a completion signal is
recorded, force `blocked` (`agentCrash`) if everything is terminal with no signal.
**Caveat:** "finalize if a completion signal is recorded" must respect §3.1 — do not mark
`done` (and thus stop timers/release leases/drop delivery) while approval or post-approval
work is unresolved. Recovery is preserved and **generalized**: GitHub-specific recovery and
the broader GitHub event path move behind a **connector-declared recovery hook** so the
recovery pass invokes `connector.recoverRun(run)` (§7, Phase 5).

### 6.6 Idempotency summary

| Operation | Idempotency mechanism |
|---|---|
| Activate a node | short-circuit on existing active executions |
| Deliver a message (target) | `idempotency_key` unique index on inbox |
| Claim a work item | lease row CAS + fencing token |
| Finalize run to terminal | canonical task-status guard (re-entry short-circuits on `task.status === 'done'`) |
| Gate open cache | `gate_open_state` with staleness guard |
| Post-approval dispatch | `postApprovalSessionId` + liveness probe (double-fire guard) |
| **Mutating connector op** (target) | command idempotency key + reconcile-unknown (§5) |
| **Connector/gate retry** (target) | persisted deadline rehydrated on restart (§6.3) |

## 7. Compatibility map — current → target

Extraction behind adapters; each row is a bounded change (phases in §9).

| Current (domain-specific / gap) | Target (generic / closed) | Adapter strategy |
|---|---|---|
| `requireCodexApproval` / `codexPollIntervalMs` / `codexTimeoutSeconds` on the generic node types — `WorkflowNode` (`space.ts:2287`), `WorkflowNodeInput` (`:2321`), **and `ExportedWorkflowNode` (`:2802`)** — plus the `effectiveNodes` projection in `updateWorkflow` (`space-workflow-manager.ts:314-316, 325-327`) | `node.gateFeatureOverrides['codex_review_bot']` on all three shapes | dual-read; all three type copies + the projection updated together or the export round-trip leaks codex; deprecated alias until migrated |
| `gate-features.ts` codex paths (first ref `:36` through `maybeInjectCodexFeature` at `:619`; file is 631 lines) + Codex validation (`space-workflow-manager.ts:559–646`) | `codex_review_bot` registered via existing `registerGateFeature` plugin | move compiler into a `gate-features/codex.ts` plugin; validation → generic override-schema validation |
| `pr_url` implicit **runtime handoff**: `ChannelRouterConfig.getPrUrlForRun` (`channel-router.ts:363`, `:1547`), `gate-script-executor` `PR_URL` env, `gate-evaluator` `gateData.pr_url` (`:563`), post-approval template context | generic per-run **`runtime_context`** map; `pr_url` is one populated key | dual-read `runtime_context['pr_url'] ?? legacy`; **PR data already lives in `workflow_run_artifacts`** — `space_tasks.pr_url/pr_number/pr_created_at` were dropped in M84 (`runMigration84`, `migrations.ts:6514`, table rebuild `space_tasks_m84_new`) and the `:2255`/`:2771` occurrences are the legacy room `tasks` table / the historical pre-M84 `space_tasks` CREATE respectively. Compat source = `gate_data` + hook-local state + `workflow_run_artifacts` |
| Full GitHub external-event path in `space-runtime.ts`: PR-subscription restart recovery (`rehydrateActiveRunPrEventSubscriptions`), topic normalization, check-failure reopening, PR-URL extraction/matching, automatic subscriptions, retained-event replay | connector-declared `recoverRun` + connector-owned subscription/matching/reopen policy | move the whole path behind github-connector capabilities (Phase 5); legacy retained until proven |
| Mutable definitions + `ON DELETE CASCADE` `workflow_id` + no `deleteWorkflow` guard | immutable + versioned + pinned + deletion-safe (§4) | shadow-write version history; tombstone/version-FK + active-run guard; remove the cascade |
| Inline crash-retry-with-counting | append-only attempts + leases (§6.3–6.4) | preserve idle/reactivation lifecycle (§3.2); attempt table + lease behind flag |
| Live-target delivery bypasses durable inbox; in-memory retry deadlines; upsert "audit" | transactional outbox + durable retry deadlines + append-only transition log (§6.1–6.4) | new durability phases |
| Mutating connectors with no command idempotency | command key + reconcile-unknown (§5) | extend contract before mutating connectors ship |
| Two **active** goal models: `goals`/`mission_executions` (Mission System: `goal-repository.ts`, `atomicStartExecution`, monotonic `execution_number`, driven by `goal-automation-execute.handler.ts`) **and** `space_goals`/`space_goal_events` | undecided — unification requires a dedicated audit | **deferred** (Phase 7 re-scoped); neither is assumed legacy |

**What is already correct and untouched:** topology model, agent slots + `toolGuards` +
`eventInterests`, gate field/script/validator/poll model, channels + cycle caps,
`pending_agent_messages`/`space_agent_inbox_messages` durable delivery **for inactive
targets**, `gate_open_state`, `workflow_run_artifacts`, `task_schedules`/`job_queue`
schedules, connector registry, the LLM workflow selector, and the channel-directed-
send-as-activation semantics (§2).

## 8. Reference workflows (expressiveness proof)

Four definitions prove the kernel + connectors express each domain without core changes.
The first exists; the others are sketched to validate the model. Note: the ecommerce and
travel sketches use **mutating** connectors and therefore depend on the §5 idempotency work.

### 8.1 PR review (exists today)

`CODING_WORKFLOW` / `FULLSTACK_QA_LOOP_WORKFLOW`. Nodes: Coder → Review → QA →
Post-Approval. Gates: `pr_ready` (connector `github.getPrReadiness` + predicate),
`codex_review_bot` (feature), human approval gate. Post-approval: PR Merger slot. Target =
same definition with `pr_url` from `runtime_context` and codex from
`gateFeatureOverrides`.

### 8.2 Ecommerce return (new sketch; uses mutating connectors)

```
[intake] → [eligibility gate] → [inspect] → [decision gate]
   ├─ refund  → [shop.issueRefund] → [notify] → end
   └─ exchange→ [shop.restockItem] → [ship replacement] → end
```
High-value returns: human approval gate. Mutating ops (`issueRefund`, `restockItem`) require
the §5 command-id + reconcile contract.

### 8.3 Manufacturing defect / CAPA (new sketch)

```
[report] → [triage] → [containment] → [corrective-action gate] → [implement CAPA] → [verification gate] → [close]
```
Severity-driven routing; QA sign-off gates (`writers: []`); recurring trend monitor
(`task_schedule`). Connectors: `mes.fileDefect`, `mes.getRouting`, `mes.recordNonconformance`.

### 8.4 Personal travel assistant (new sketch; uses mutating connectors)

```
[capture intent] → [search flights + hotels] → [assemble itinerary] → [confirmation gate] → [travel.book] → [reminders (timer)] → [monitor]
```
`travel.book` requires §5 idempotency.

**Conclusion:** all four are expressible as definitions + connectors. No topology/gate/timer
concept must be added. The only contract addition is mutating-connector idempotency (§5).

## 9. Phased roadmap

One compatibility-preserving PR per phase. Each: shadow/flag first, dual-read only when
necessary, migration + restart/concurrency tests, explicit rollback. **No phase removes
legacy behavior before parity evidence exists.** New durability phases (1b–1e) close the
verified gaps before the extraction phases that depend on them.

| Phase | Deliverable | Mode | Rollback |
|---|---|---|---|
| **0** (this RFC) | RFC + ADR, approval | docs only | n/a |
| 1 | Immutable versioned definitions: in-row `definition_version` hash pinned on runs + `space_workflow_definition_versions` history **+ deletion-safety** (tombstone/version-FK, active-run guard in `deleteWorkflow`, remove `workflow_id` cascade) | shadow-write history; runs read pinned version; legacy live-read unaffected | drop pin column; restore cascade |
| **1b** | Transactional outbox: persist every resulting delivery (live + inactive) in the transition transaction; `AgentMessageRouter` drains rows | write both paths; cutover when proven | fall back to direct live delivery |
| **1c** | Durable retry deadlines: persist connector/gate `retryAfterMs` to timer/job model; rehydrate/cancel by `(run, gate)` | new table/job type | in-memory scheduler still works while populated |
| **1d** | Append-only `workflow_transition_log` (status/approval/cancel/gate-reset/routing, + actor + command) | append-only; readers opt-in | stop writing; no behavior change |
| 2 | Generic `runtime_context` map; extract `pr_url` runtime handoff behind it | dual-read `runtime_context['pr_url'] ?? legacy`; source = `gate_data`/hook-state/`workflow_run_artifacts` (columns already gone post-M84) | flip dual-read back |
| 3 | Generic `gateFeatureOverrides`; extract `codex_review_bot` to a plugin (all three node type copies + `effectiveNodes`) | keep `requireCodexApproval` as deprecated alias | alias still honored |
| 4 | Append-only attempts + leases/fencing (flag-gated); **preserve idle/reactivation lifecycle** (§3.2) | flag off = single-process no-op | toggle flag |
| **4b** | Mutating-connector readiness: command idempotency key + reconcile-unknown on `ConnectorContext`/`ConnectorOp` | read-only connectors unaffected | gate behind connector capability flag |
| 5 | Full GitHub external-event path behind connector capabilities (`recoverRun` + subscription/matching/reopen) | github-connector owns the path; legacy retained until proven | fall back to legacy paths |
| 6 | ecommerce-return, manufacturing-defect, travel definitions + connectors as **in-tree `reference/` fixtures** (not seeded) + tests | read-only reference; no production seeding | remove fixture |
| 7 | **Goal-system unification audit** (not "retire legacy"): determine the relationship between `goals`/`mission_executions` and `space_goals`; decide migration/freeze **from evidence** | investigation + design only first | n/a |

## 10. Deferred features (do not build speculatively)

- Subprocesses / nested workflow calls; complex event correlation (CEPII); distributed /
  horizontally-scaled execution (leases are the seam); compensation/saga rollback (use
  explicit corrective nodes); org/role modeling beyond slots + `writers`; visual designer /
  BPMN import; process mining; BPEL orchestration-vs-choreography refactor.
- **Goal-system unification** (Phase 7) — requires a dedicated audit; do not assume either
  model is legacy.

## 11. Migration safety invariants (must hold throughout)

1. **No silent reinterpretation of active runs** — a run executes its pinned definition
   version; edits/deletions never mutate or erase in-flight runs (Phase 1 + deletion-safety).
2. **No legacy removal before parity** — every extraction keeps the old path until a
   migration test + production evidence show equivalence.
3. **One invariant/capability per PR** — each phase independently reviewable and revertible.
4. **Migration + restart/concurrency tests** accompany every runtime change — recovery,
   idempotency, lease correctness, outbox atomicity, and durable-retry rehydration tested
   under crash + duplicate-wake + concurrent-claim + restart.
5. **Domain concepts never re-enter the generic type or core paths.** Acceptance criterion:
   `grep` for `pr_url`, `codex`, `requireCodexApproval` in `packages/shared/src/types/space.ts`
   (incl. `ExportedWorkflowNode`) and `packages/daemon/src/lib/space/runtime/*`, plus the
   `effectiveNodes` projection in `managers/space-workflow-manager.ts` and the GitHub
   external-event symbols in `space-runtime.ts`, returns nothing outside adapters/plugins
   (measured over phases).
6. **A run is not terminal until its task and post-approval route are** (§3.1) — durability
   consumers (leases, timers, delivery) must key off true terminal state, not
   `reportedStatus`/`CompletionDetector` alone.

## 12. Design-review decisions (resolved / revised)

From the review of PR #2396. All re-verified against code.

1. **Definition versioning** → in-row content hash pinned on run + append-only
   `space_workflow_definition_versions` history table. (Phases 1.) **Plus deletion-safety**
   (tombstone/version-FK + active-run guard) — added after verification showed the
   `ON DELETE CASCADE` + guardless `deleteWorkflow` gap.
2. **Lease scope** → flag-gated no-op for single-process; enforced only when a second worker
   exists. (Phase 4.)
3. **Goal V2 unification** → ~~freeze legacy read-only~~ **REVERSED.** Verification shows
   `goals`/`mission_executions` is an **active** Mission System (`goal-repository.ts`,
   `atomicStartExecution` with monotonic `execution_number`, driven by
   `goal-automation-execute.handler.ts`), not legacy. Freezing it would halt active
   behavior. Re-scoped to a unification **audit** in Phase 7; no freeze or retirement
   without evidence. (The original "freeze" decision rested on an unverified premise —
   flagged to the reviewer.)
4. **Reference workflows** → in-tree under a marked `reference/`/fixtures path, not seeded.
   (Phase 6.)

Phase 0 produces no code; upon approval, Phase 1 (+ durability cluster 1b–1d) begins behind
adapters.
