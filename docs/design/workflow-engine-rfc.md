# RFC: Data-Defined Workflow Engine

Status: Proposed (Phase 0 — architecture only; no runtime changes)
Date: 2026-08-07
Tracks: Goal task #874 — "Evolve HyperNeo into a generic data-defined workflow engine"
Companion: `docs/adr/0003-data-defined-workflow-engine.md`

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
- Retiring the legacy `room/` Mission System. It is mapped to a compatibility adapter and
  scheduled for retirement only after parity and migration evidence exist.

### Why this is tractable now

The current engine is already **~85% data-defined**. A code survey confirms:

- There is **no `switch(workflowType)` or `switch(nodeType)` dispatch** anywhere in the
  core runtime. Topology (nodes/channels/gates/hooks/post-approval), gate evaluation, cycle
  caps, completion detection, and post-approval routing are all driven by data.
- A clean **connector abstraction already exists** (`packages/daemon/src/lib/space/runtime/connectors/`)
  with a generic registry (`Connector` / `ConnectorOp` / `ConnectorOutcome` /
  `ConnectorAuth`), a predicate DSL (`predicate.ts`), and validator presets. The engine
  already admits any registered connector id — `'github'` is no longer special in the type.
- The connector layer is being rolled out **behind a feature flag**
  (`isConnectorsLayerEnabled()`, gated in `hook-executor.ts`).

So this is **not a rewrite**. It is a bounded extraction: purge the remaining
domain-specific concepts (GitHub/PR/Codex) from the generic type and core paths, harden
the durability seams that single-process execution let us defer, and formalize the
versioning and recovery model. The concrete leakage sites are enumerated in §6.

## 2. Canonical concepts

We adopt the existing vocabulary wherever it is already correct — a parallel rename would
violate the incremental, compatibility-first constraint. New terms are introduced only
where the current model conflates or omits something.

| Canonical term | Current implementation | Notes |
|---|---|---|
| **Definition** | `SpaceWorkflow` (`packages/shared/src/types/space.ts:2419`) | Becomes **immutable + versioned** (§4). |
| **Run** | `space_workflow_runs` row (`migrations.ts:2713`) | One execution of a definition. Pins `definition_version`. |
| **Work item** | `node_executions` row (`migrations.ts:5912`) | A unit of work assigned to a worker. Statuses: `pending\|in_progress\|idle\|waiting_rebind\|blocked\|cancelled\|done`. |
| **Attempt** | (implicit: crash-retry-with-counting in tick loop) | **New, append-only**: an execution attempt of a work item. Makes retries auditable (§5). |
| **Token / activation** | `ChannelRouter.activateNode` creating `node_executions` | Lazy, event-driven. A message or gate-open *activates* a downstream node. |
| **Gate** | `Gate` + `gate_data` + `gate_open_state` | Declaration in definition; runtime state in `gate_data`; open-cache in `gate_open_state`. |
| **Channel** | `WorkflowChannel` (`space.ts:2215`) | Directed message pipe `from → to`, optional `gateId`, `maxCycles`. |
| **Approval** | Gate with `requiredLevel` / external `writers: []` field + `completionAutonomyLevel` | Human or autonomy-gated sign-off. |
| **Delivery** | `pending_agent_messages` (inbox) + `AgentMessageRouter` (outbox) | Durable, idempotent (§5). |
| **Timer** | `task_schedules` (cron/at) + `GatePoll` (interval) + hook retry timers | Three existing timer mechanisms, unified conceptually. |
| **Connector / capability** | `connectors/` registry + validator presets | Domain actions behind an id. |
| **Task** | `space_tasks` | User-facing unit; 1:1 with a run via `workflow_run_id`. Sole completion source of truth. |
| **Goal** | `space_goals` (Goal V2) + legacy `goals` | The **what/when layer**: objectives, recurring triggers, progress. Layered above the engine. |
| **Worker** | A Space agent session (`space_chat` / `space_task_agent` / LH agent) | Agents/humans/services are all workers. Sessions are execution *resources*, not workflow identity. |

**Mental model.** A *Goal* says *what* to achieve and *when* (trigger layer). It creates a
*Task* and a *Run* of a *Definition*. The kernel drives the run by *activating work items*
along *channels*, respecting *gates*. Workers (agents/humans/services) pick up work items,
emit *outcomes* (messages, gate writes, artifact writes, commands), and the kernel
transitions the run deterministically. *Connectors* provide domain actions workers or
gates call. Delivery is durable and idempotent so workers can crash, retry, and recover
without losing or duplicating work.

### What advances process state

> **Messages communicate; explicit outcomes/signals/commands advance process state.**

A message alone never transitions a run. State advances only through *structured* acts that
the kernel interprets: a gate write that opens a gate (→ activates downstream work items),
a terminal work-item outcome (`done`/`cancelled`), an explicit command
(`submit_for_approval`, `approve_task`, `mark_complete`), or a timer firing. Free-text
messaging between workers does not move the process graph. This is already the case today
and is preserved as an invariant.

## 3. Lifecycle / state-transition tables

These are the **executable** transition tables the kernel enforces. They are encoded as
data (the current `VALID_NODE_EXECUTION_TRANSITIONS` pattern is the model). Where the
existing transition set already matches, the table is a formalization, not a change.

### 3.1 Run lifecycle

| from | event | to | guard | side effect |
|---|---|---|---|---|
| `pending` | start node activated | `in_progress` | definition resolvable at pinned version | stamp `definition_version` |
| `in_progress` | completion signal recorded | `done` | `CompletionDetector.isComplete` (task `done`/`cancelled` or `reportedStatus != null`) | fire idempotent completion actions (`completion_actions_fired_at`) |
| `in_progress` | all work items terminal, no completion signal, restart | `blocked` | recovery pass | `failure_reason = 'agentCrash'` |
| `in_progress` | human reject | `blocked` | `failure_reason = 'humanRejected'` | — |
| `in_progress` | max iterations / node timeout | `blocked` | `failure_reason ∈ {maxIterationsReached, nodeTimeout}` | — |
| `in_progress`/`blocked` | human cancel | `cancelled` | — | cascade-cancel work items, release leases |
| `blocked` | manual restart / recovery claim | `in_progress` | work item re-activated | — |

`done`, `cancelled` are **terminal**. `blocked` is recoverable. Legacy `completed`/
`needs_attention` strings are compatibility aliases for `done`/`blocked`.

### 3.2 Work item lifecycle

| from | event | to | guard | side effect |
|---|---|---|---|---|
| `pending` | worker claims | `in_progress` | lease acquired (§5), idempotent activation short-circuit | append attempt #1 |
| `in_progress` | worker emits terminal outcome | `done` | completion checks pass | release lease |
| `in_progress` | worker needs peer input | `idle` / `waiting_rebind` | — | lease continues or parks |
| `in_progress` | gate blocks downstream | (self unchanged) | — | downstream not activated |
| `in_progress` | worker crash / lease expiry | `pending` (retry) | attempt budget remaining, not terminal | append attempt #N, backoff |
| `in_progress`/`idle` | timeout | `pending` (retry) | budget remaining | append attempt #N |
| `pending`/`in_progress` | run cancelled | `cancelled` | — | release lease |
| `pending` (retry exhausted) | max attempts reached | `blocked` | — | run → `blocked` (`agentCrash`) |

`done`, `cancelled` are terminal. Today, retries are inline (crash-retry-with-counting);
this RFC formalizes them as an **append-only attempt log** (§5) without changing the
observable behavior.

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

### 3.4 Delivery (inbox/outbox) lifecycle

| from | event | to | notes |
|---|---|---|---|
| `pending` | target worker activates | `delivered` | `flushPendingMessagesForTarget`, idempotent by `idempotency_key` |
| `pending` | TTL (60s) elapsed, attempts < max (3) | `pending` (retry) | backoff |
| `pending` | max attempts reached | `failed` | actionable terminal failure surfaced |
| `pending` | run/work item terminal | `failed` | do not deliver to dead workers |

### 3.5 Timer lifecycle

| type | trigger | effect |
|---|---|---|
| schedule (`task_schedules`) | cron / `run_at` reaches `next_run_at` | enqueue fire job → creates a new run/task instance |
| gate poll (`GatePoll`) | `intervalMs` tick while run `in_progress` | run gate script; if stdout changed, inject message into target node |
| hook retry (`WorkflowHookRetrySettings`) | `next_retry_at` | re-run hook with backoff |

All timers stop on run terminal state.

### 3.6 Approval lifecycle

| from | event | to | guard |
|---|---|---|---|
| work item emits `submit_for_approval` | command accepted | task `review` | `space.autonomyLevel < completionAutonomyLevel` → human gate; else auto |
| task `review` | human `approve` | `approved` → post-approval route | double-fire guard (`postApprovalSessionId` set + alive → no-op) |
| task `review` | human `reject` | `in_progress` (feedback to worker) | — |
| `approved` | post-approval route done | `done` | `mark_complete` |

## 4. Workflow-definition schema (immutable, versioned)

**Problem today.** Definitions are mutable (`SpaceWorkflowManager.updateWorkflow`) and
only soft-version-tracked via `templateHash` + `updatedAt`. Node IDs are stable
(`validateStableNodeIds`) so a definition edit can silently change the behavior of an
*in-flight* run. This violates the "data-defined behavior" rule for durability: a run
must execute against the exact definition it started under.

**Decision.**

1. Introduce a **definition version** as a content hash of the canonicalized definition
   (extend `workflows/template-hash.ts`). Store `definition_version` on the **definition
   row** and **pin it on the run** at start (`space_workflow_runs.definition_version`).
2. Editing a definition produces a **new version row** (or, pragmatically, a new
   `definition_version` stamped on the same row with the prior version retained in an
   append-only `space_workflow_definition_versions` audit table). Existing runs keep
   reading their pinned version; new runs get the latest.
3. Built-in template re-stamping (`seedBuiltInWorkflows` hash-drift merge) becomes
   version-bumping rather than in-place mutation of live behavior.
4. The shape of `SpaceWorkflow` is otherwise unchanged — this is a versioning wrapper, not
   a schema redesign. Existing readers keep working; they simply resolve through the
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
  runtimeContextContract?: RuntimeContextKey[]; // §6.2 — replaces implicit pr_url

  tags?: string[];                  // workflow-selector hints (default, v2, …)
}

interface Node {
  id: string; name: string;
  agents: NodeAgent[];              // slots: agentId, model, prompt, toolGuards, timeoutMs, …
  gateFeatureOverrides?: Record<string, unknown>; // §6.1 — replaces requireCodexApproval
  postApproval?: PostApprovalRoute;
}
```

Definitions are **declarations**; the kernel interprets them. Adding a domain (ecommerce,
manufacturing, travel) means authoring a definition + registering connectors — **zero
kernel changes**.

## 5. Capability / connector contract

The contract already exists and is correct. We formalize it; no redesign.

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

- **Registry**: `registerConnector` / `getConnector` / `isRegisteredConnector` /
  `getRegisteredConnectorIds`. Side-effect modules (`connectors/production.ts`) register
  at startup.
- **Validator layer**: a gate `validator: { kind: 'built_in', id }` composes a connector op
  + a predicate (`eq`/`empty`/`all`/`any`). The validator does not know what a PR is —
  domain knowledge lives in `connectors/presets.ts`.
- **Domain packs** ship as connector + preset modules:
  - `github` (existing): `getPr`, `getPrReadiness`, `getReactions`, `getReviewEvidence`;
    presets `pr_ready`, `pr_merged`, `review_posted`, `codex_review_bot`.
  - `shop` (new, reference): `createReturn`, `getOrder`, `issueRefund`, `restockItem`.
  - `mes` (new, reference): `fileDefect`, `getRouting`, `recordNonconformance`.
  - `travel` (new, reference): `searchFlights`, `searchHotels`, `book`, `getItinerary`.

The kernel calls connectors by id+op. Outcomes are typed `ConnectorOutcome` so
retryability and rate-limit backoff (`retryAfterMs`) are first-class — the existing
`GateRetryScheduler` path already consumes these.

## 6. Durability, transaction, and recovery model

### 6.1 SQLite command transaction boundary

Every state transition is a **single SQLite transaction** that atomically:
1. validates the guard (CAS-style `WHERE current_status = ?`),
2. writes the new status + append-only attempt/audit row,
3. enqueues any resulting delivery/outbox messages and timers, and
4. releases/acquires leases.

This is the existing pattern (`db.transaction()` for atomic cycle-increment +
gate-data-reset in `channel-router.ts:244`). The rule is to **never split a transition's
write across transactions** — outbox/delivery must be enqueued in the same transaction as
the state write (transactional outbox), so a crash between "state written" and "message
sent" is impossible.

### 6.2 Inbox / outbox

- **Outbox** (within the transition transaction): messages to be delivered. `AgentMessageRouter`
  is the outbox dispatcher.
- **Inbox** (`pending_agent_messages` for node-agents; `space_agent_inbox_messages` for
  long-horizon agents): durable queues drained on worker activation.
- **Idempotency**: `idempotency_key` unique partial indexes on both inboxes. Duplicate
  wake/deliver requests are no-ops. Activation is idempotent (`activateNode` short-circuits
  on existing active executions).

### 6.3 Leases / fencing (the main durability gap)

Today there is **no lease or fencing token** — the daemon is single-process and relies on
SQLite transactions + per-gate evaluation coalescing. This is acceptable while single-process
but blocks future multi-worker durability and makes "is this work item actually still being
worked?" non-observable.

**Decision (designed now, required only when distributed):**

- A worker **claims** a work item by acquiring a lease row
  `work_item_leases(work_item_id, owner, fencing_token, expires_at)` in the same
  transaction that sets `in_progress`.
- A **fencing token** (monotonic per work item) invalidates stale claims: any write from a
  token older than the current lease is rejected. This is the classic fencing-token
  pattern and is necessary the moment a worker can be resurrected after a crash and
  operate on stale state.
- Leases are **refreshed on real progress** (SDK message stream tick) so slow-but-alive
  work is not falsely retried — directly addressing the recurring bug class in tasks
  #859–#862 (stranded message delivery).
- Recovery reclaims work items whose lease expired without progress.

This is introduced **behind a flag** and is a no-op for the single-process path until a
second worker exists. It is the dependency-ready seam for #859–#862's recovery phase.

### 6.4 Append-only attempts and audit

- **Attempts** (`node_execution_attempts`, new): one row per execution attempt of a work
  item — `work_item_id`, `attempt_number`, `owner`, `started_at`, `ended_at`, `outcome`,
  `failure_reason`. Retries append; nothing mutates history.
- **Audit**: `workflow_run_artifacts` (typed node outputs) + `workflow_hook_result_artifacts`
  (hook results) already form an audit trail; attempts complete it. Every transition is
  reconstructable from append-only tables.

### 6.5 Recovery

`SpaceRuntimeService.start()` chains recovery today (long-term inbox →
`recoverStalledRuns`): skip if work is in flight, finalize if a completion signal is
recorded, force `blocked` (`agentCrash`) if everything is terminal with no signal. This is
preserved and **generalized**: GitHub-specific recovery
(`rehydrateActiveRunPrEventSubscriptions`) moves behind a **connector-declared recovery
hook** so the recovery pass invokes `connector.recoverRun(run)` for each connector the run
used (§7).

### 6.6 Idempotency summary

| Operation | Idempotency mechanism |
|---|---|
| Activate a node | short-circuit on existing active executions |
| Deliver a message | `idempotency_key` unique index on inbox |
| Claim a work item | lease row CAS |
| Fire completion actions | `completion_actions_fired_at` stamp |
| Gate open cache | `gate_open_state` with staleness guard |
| Post-approval dispatch | `postApprovalSessionId` + liveness probe (double-fire guard) |

## 7. Compatibility map — current → target

The migration is extraction behind adapters. Each row is a bounded change; phases in §9.

| Current (domain-specific) | Target (generic) | Adapter strategy |
|---|---|---|
| `WorkflowNode.requireCodexApproval` / `codexPollIntervalMs` / `codexTimeoutSeconds` (`space.ts:2287`, dup `:2321`) | `node.gateFeatureOverrides['codex_review_bot']` | dual-read; built-in templates rewritten to the override form; field kept as deprecated alias until templates migrate |
| `gate-features.ts` Codex compiler (`:209–510`) + Codex validation (`space-workflow-manager.ts:559–646`) | `codex_review_bot` registered via existing `registerGateFeature` plugin | move compiler into a `gate-features/codex.ts` plugin module; validation becomes generic override-schema validation |
| `pr_url` implicit handoff: `ChannelRouterConfig.getPrUrlForRun` (`channel-router.ts:363`, `:1547`), `gate-script-executor` `PR_URL` env, `gate-evaluator` `gateData.pr_url` (`:563`), post-approval template context, `space_tasks.pr_url/pr_number/pr_created_at` columns (`migrations.ts:2255`) | generic per-run **`runtime_context`** map; `pr_url` is one populated key | dual-read `runtime_context['pr_url'] ?? legacy`; migration 84's stated intent ("replace pr columns with artifacts", `migrations.ts:380`) is the canonical path — PR data moves to `workflow_run_artifacts` |
| `rehydrateActiveRunPrEventSubscriptions` (`space-runtime-service.ts:2523`) | `connector.recoverRun(run)` invoked for each run-used connector | GitHub connector declares the recovery hook; runtime calls generically |
| Mutable definitions (`updateWorkflow`) | immutable + versioned, pinned on run (§4) | shadow-write version table first; runs read pinned version; edit produces new version |
| Inline crash-retry-with-counting | append-only attempts + leases (§6.3–6.4) | introduce attempt table + lease behind flag; behavior identical until multi-worker |
| Two goal systems: legacy `goals`/`mission_executions` vs `space_goals` | single Goal V2 trigger layer above the engine | legacy tables retained read-only; no new writes; retire after parity |

**What is already correct and untouched:** topology model, agent slots + `toolGuards` +
`eventInterests`, gate field/script/validator/poll model, channels + cycle caps,
`pending_agent_messages`/`space_agent_inbox_messages` durable delivery, `gate_open_state`,
`workflow_run_artifacts`, `task_schedules`/`job_queue` timers, connector registry, the
"messages communicate, outcomes advance state" invariant, and the LLM workflow selector
(returning an id with deterministic tag fallback).

## 8. Reference workflows (expressiveness proof)

Four definitions prove the kernel + connectors express each domain **without core changes**.
The first already exists; the other three are sketched to validate the model, not to ship.

### 8.1 PR review (exists today)

`CODING_WORKFLOW` / `FULLSTACK_QA_LOOP_WORKFLOW` in `built-in-workflows.ts`. Nodes:
Coder → Review → QA → Post-Approval. Gates: `pr_ready` (connector `github.getPrReadiness`
+ predicate), `codex_review_bot` (feature), human approval gate
(`completionAutonomyLevel`). Post-approval: PR Merger slot. **Already data-defined**;
target = same definition with `pr_url` read from `runtime_context` and codex from
`gateFeatureOverrides`.

### 8.2 Ecommerce return (new sketch)

```
[intake: receive return] → [eligibility gate] → [inspect] → [decision gate]
   ├─ refund  → [connector shop.issueRefund] → [notify] → end
   └─ exchange→ [connector shop.restockItem] → [ship replacement] → end
```
- High-value returns: human approval gate (`requiredLevel`).
- Connectors: `shop.getOrder`, `shop.createReturn`, `shop.issueRefund`, `shop.restockItem`.
- No GitHub knowledge anywhere in the kernel.

### 8.3 Manufacturing defect / CAPA (new sketch)

```
[report defect] → [triage: root-cause + severity] → [containment] → [corrective-action gate]
   → [implement CAPA] → [verification gate] → [close] → end
```
- Severity-driven routing via gate fields.
- QA sign-off gates with `writers: []` (external/human).
- Recurring goal monitors defect trends (`task_schedule` cron) — leverages Goal V2.
- Connectors: `mes.fileDefect`, `mes.getRouting`, `mes.recordNonconformance`.

### 8.4 Personal travel assistant (new sketch)

```
[capture intent] → [search: shop flights + hotels] → [assemble itinerary]
   → [confirmation gate] → [book] → [pre-trip reminders (timer)] → [during-trip monitor]
```
- Confirmation gate = human approval.
- Timers: `GatePoll` or `task_schedule` for reminders.
- Connectors: `travel.searchFlights`, `travel.searchHotels`, `travel.book`.
- Demonstrates human-in-the-loop + timers + multiple connectors.

**Conclusion of §8:** all four domains are expressible as definitions + connectors. No
field, gate primitive, timer, or delivery concept needs to be added to satisfy them. This
is the evidence that the generic kernel is sufficient and that BPMN-scale features can be
deferred.

## 9. Phased roadmap

One compatibility-preserving PR per phase. Each phase: shadow projection or feature flag
first, dual-read/write only when necessary, migration tests, explicit rollback criteria.
**No phase removes legacy behavior before parity evidence exists.**

| Phase | Deliverable | Mode | Rollback |
|---|---|---|---|
| **0** (this RFC) | RFC + ADR, approval | docs only | n/a |
| 1 | Immutable versioned definitions; pin `definition_version` on runs | shadow-write version table; runs read pinned version; legacy reads unaffected | drop the pin column; behavior reverts to live-read |
| 2 | Generic `runtime_context` map; extract `pr_url` behind it | dual-read `runtime_context['pr_url'] ?? legacy`; move `space_tasks.pr_url*` → artifacts (migration 84 intent) | flip dual-read back to legacy |
| 3 | Generic `gateFeatureOverrides`; extract `codex_review_bot` to plugin | keep `requireCodexApproval` as deprecated alias; templates rewritten | alias still honored |
| 4 | Append-only attempts + leases/fencing (flag-gated) | flag off = single-process no-op; flag on = lease enforced | toggle flag |
| 5 | Connector-declared `recoverRun` hook; extract PR subscription recovery | GitHub connector declares hook; runtime calls generically; legacy path retained until proven | fall back to legacy rehydrate |
| 6 | Author ecommerce-return, manufacturing-defect, travel definitions + connectors as **reference fixtures + tests** | read-only reference; no production wiring | remove fixture |
| 7 | Retire legacy `room/` Mission System (goals/mission_executions) | after parity + no writes for N releases | tables retained read-only |

Phases 1–5 are the dependency-ready core; 6 validates genericity; 7 is cleanup. Each is
small, reviewable, and independently revertible.

## 10. Deferred features (do not build speculatively)

Each is deferred until a reference workflow or an observed failure requires it.

- **Subprocesses / nested workflow calls.** Current flat + cyclic-channel model suffices;
  add when a reference workflow genuinely needs composition.
- **Complex event correlation (CEPII).** Current `eventInterests` topic globs +
  `subscribe_external_event` suffice.
- **Distributed / horizontally-scaled execution.** Single-process until a measured
  bottleneck. Leases (§6.3) are the seam.
- **Compensation / saga rollback transactions.** Use explicit corrective nodes in the
  definition instead; add saga semantics only if rollback correctness proves too hard to
  model declaratively.
- **Organization / role modeling beyond agent slots + `writers`.** Defer until a domain
  needs an org chart.
- **Visual designer / BPMN import / process mining.** Out of scope.
- **BPEL-style orchestration-vs-choreography refactor.** Current agent-centric choreography
  is the model; keep it.

## 11. Migration safety invariants (must hold throughout)

1. **No silent reinterpretation of active runs.** A run executes its pinned definition
   version; definition edits never mutate in-flight runs (Phase 1).
2. **No legacy removal before parity.** Every extraction keeps the old path until a migration
   test + production evidence show equivalence.
3. **One invariant or capability per PR.** Each phase is independently reviewable and
   revertible (explicit rollback column above).
4. **Migration tests + restart/concurrency tests accompany every runtime change.** Recovery
   (`recoverStalledRuns`), idempotency (`idempotency_key`), and lease correctness are
   tested under crash + duplicate-wake + concurrent-claim.
5. **Domain-specific concepts never re-enter the generic type or core paths.** The RFC's
   acceptance criterion: `grep` for `pr_url`, `codex`, `requireCodexApproval` in
   `packages/shared/src/types/space.ts` and `packages/daemon/src/lib/space/runtime/*`
   returns nothing outside adapters/plugins (measured over phases, not required at Phase 0).

## 12. Open questions for review

1. **Definition versioning storage**: separate `space_workflow_definition_versions` table vs.
   in-row versioning with an audit table — which is preferred given the mutation-heavy
   built-in re-stamping flow?
2. **Lease scope**: do we want leases required for the single-process path now (stronger
   invariants, more code) or strictly flag-gated until a second worker exists (smaller
   blast radius)? This RFC proposes flag-gated; confirm.
3. **Goal V2 unification**: should legacy `goals`/`mission_executions` be migrated to
   `space_goals` explicitly, or frozen read-only until organic attrition? (Affects Phase 7
   only.)
4. **Reference workflow ownership (Phase 6)**: ship ecommerce/manufacturing/travel as
   in-tree reference fixtures (recommended) vs. a separate examples package.

Phase 0 produces no code; upon approval, Phase 1 begins behind adapters.
