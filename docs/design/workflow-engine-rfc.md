# RFC: Data-Defined Workflow Engine

Status: Proposed — Revision 11 (Phase 0, architecture only; no runtime changes).
Incorporates all human + codex-connector review rounds to date. Every
code-level claim below was re-verified directly against the current source this
revision. Per the agreed scope rule, this revision states **complete invariants +
phase boundaries** and defers all mechanism (sequences, tables, schemas, wiring) to
the phase PRs. Date: 2026-08-08. Tracks goal task #874.
Companion: `docs/adr/0003-data-defined-workflow-engine.md`.

> **Honest thesis (revised).** The engine's *definition model* (topology / gates /
> channels / hooks / post-approval) and its *connector registry* are already generic
> and data-defined, and there is no `switch(workflowType/nodeType)` dispatch in core.
> **But** the engine is **not** "fully expressive with zero kernel changes": it lacks
> primitives a durable, domain-agnostic framework needs — **imperative connector-action
> steps** (connectors are read-only validators/hooks today), **in-run pause/resume
> timers**, a **transactional outbox**, **durable retry deadlines**, an **append-only
> transition log**, **deletion-safe versioning**, and **mutating-connector idempotency**.
> These missing primitives are the bulk of the remaining work — they are NEW, not
> extraction — and are forced by the reference workflows (§8), not speculative.

## 1. Goal and non-goals

### Goal

Evolve HyperNeo's Space workflow system into a **domain-agnostic, durable execution
framework** for business processes, manufacturing, ecommerce, personal-assistant
workflows, and agent collaboration — without a big-bang rewrite.

The foundational rule:

> **Data-defined behavior, code-defined semantics, plugin-defined capabilities.**

- **Data-defined behavior** — workflow-specific behavior lives in an immutable, versioned
  **definition** the kernel interprets; the kernel never branches on *which* workflow runs.
- **Code-defined semantics** — the generic kernel owns transitions, durability, leases,
  idempotency, approvals, timers, delivery, recovery, audit, and terminal semantics.
- **Plugin-defined capabilities** — domain actions are **connectors** in a generic registry,
  invoked by id.

### Non-goals (this RFC)

- Runtime changes. Phase 0 is design + approval only.
- BPMN/BPEL parity; a visual designer; distributed multi-process execution now (we design
  the seams — leases, fencing — but stay single-process until a measured bottleneck).
- Deciding the fate of the dormant legacy `goals`/`mission_executions` tables — they are a
  documented compatibility surface, dormant at runtime (§7); a unification audit is deferred
  (Phase 7).

### What is already generic (verified)

- No `switch(workflowType)` / `switch(nodeType)` dispatch in core. Topology, gate
  evaluation, cycle caps, completion detection, post-approval routing are data-driven.
- A connector abstraction + registry exist (`connectors/`), rolled out behind a flag
  (`isConnectorsLayerEnabled()`).

### What is missing (verified) — the actual work

- **Imperative connector-action steps** do not exist: `WorkflowNode.agents` must be
  non-empty (`space.ts:2274,2276`), connectors are invoked only as read-only validators
  (`external-state-validator.ts:84,91`) and hook auth lookups (`hook-executor.ts:203,207`).
- **In-run pause/resume timer** does not exist: `task_schedules` create *new* runs,
  `GatePoll` re-evaluates a gate, hook-retries retry a hook — none pauses and later
  resumes one run.
- **Transactional outbox** absent: live targets bypass the durable inbox.
- **Durable retry deadlines** absent: `GateRetryScheduler` is in-memory.
- **Append-only transition log** absent: `workflow_run_artifacts` are upserts.
- **Deletion-safe versioning** absent: deleting a definition **orphans** runs (no FK) and
  no deletion path has an active-run guard.
- **Mutating-connector idempotency** absent: the contract carries no command key.

## 2. Canonical concepts

We keep the existing vocabulary where correct (a rename would violate incrementalism).

| Canonical term | Current implementation | Notes |
|---|---|---|
| **Definition** | `SpaceWorkflow` (`space.ts:2419`) | Becomes immutable + versioned + deletion-safe (§4). |
| **Run** | `space_workflow_runs` row (`migrations.ts:2713`) | *(target: pins `definition_version` at **creation**; today re-reads the live row each tick — §4)*. `done`/`cancelled` **reopen** to `in_progress` (`workflow-run-status-machine.ts`); the only tombstone is `SpaceTask.archivedAt`. |
| **Work item** | `node_executions` row | `pending\|in_progress\|idle\|waiting_rebind\|blocked\|cancelled`. Terminal = `idle\|cancelled` (no `done`); success parks as reactivatable `idle`. |
| **Attempt** | (implicit crash-retry-with-counting) | New, append-only (§6.4). |
| **Activation** | `ChannelRouter.activateNode` | A channel-directed `send_message` or gate-open activates a downstream node — and can reopen a finished run (below). |
| **Gate / Channel / Approval** | `Gate`+`gate_data`+`gate_open_state`; `WorkflowChannel`; `requiredLevel`/`completionAutonomyLevel` | Unchanged. |
| **Delivery** | `pending_agent_messages`/`space_agent_inbox_messages` (inbox) + `AgentMessageRouter` | Durable only for **inactive** targets today; live targets bypass the inbox (§6.1). |
| **Timer** | `task_schedules` (new-run cron/at) + `GatePoll` (repeat eval) + hook retry | **No in-run pause/resume** primitive today (§3.5). |
| **Connector** | `connectors/` registry | Read-only validators/hooks only today; **imperative connector-action steps are a new primitive** (§5). |
| **Task** | `space_tasks` | User-facing unit; 1:1 with a run. Sole completion source of truth. **archivedAt is the only tombstone.** |
| **Goal** | `space_goals` (active); `goals`/`mission_executions` (**dormant/legacy**) | One active model; the legacy tables are a documented compatibility surface, dormant at runtime (§7). |
| **Worker** | Space agent session | Agents/humans/services are workers; sessions are resources, not identity. |

**Mental model.** A *Goal* (what/when) creates a *Task* and a *Run* of a *Definition*. The
kernel activates work items along channels respecting gates. Workers emit outcomes; the
kernel transitions the run. Connectors provide domain actions. Delivery is durable and
idempotent so workers can crash, retry, and recover without loss or duplication.

### What advances process state (reconciled with reopen)

> **Channel-directed sends and explicit outcomes/commands advance state; untargeted free
> text only communicates.** Finished runs (`done`/`cancelled`) are **not** tombstones — a
> channel send can reopen them (`done→in_progress`, `cancelled→in_progress`); only
> `SpaceTask.archivedAt` is final.

This matches `workflow-run-status-machine.ts` exactly and removes the v2 contradiction
between "channel sends reopen" and "done/cancelled are terminal."

## 3. Lifecycle / state-transition tables

Executable tables the kernel enforces, encoded as data (the
`VALID_NODE_EXECUTION_TRANSITIONS` / `VALID_TRANSITIONS` patterns are the model).

### 3.1 Run lifecycle — invariants

Run statuses/transitions follow `workflow-run-status-machine.ts` verbatim — including
`pending→cancelled` (init-failure cleanup), `blocked→in_progress` (resolution), and
`done`/`cancelled→in_progress` (reopen). (`definition_version` is stamped at run creation —
§4.) Load-bearing invariants for this design:

**Reopen invariant:** reopen must move **both** the run **and** its non-archived canonical
task back to `in_progress` atomically. Today `ChannelRouter.reopenRun`
(`channel-router.ts:1810`) changes only the run status, leaving the task terminal — so
`CompletionDetector.isComplete` immediately re-finalizes the reopened run. Phase 4/1e must
make reopen also reopen the task (or completion detection must distinguish a reopened
activation); mechanism deferred to the phase PR.

**Finalization vs delivery-fail vs tombstone (reconciles §6.6 — fixes v4 over-correction):**
`done`/`cancelled` are *finished attempt states* that reopen (`workflow-run-status-machine.ts`);
**the only tombstone (non-reopenable) is `SpaceTask.archivedAt`.** Three distinct durability
signals, not one: (a) **finalization** — release leases / stop timers / stop active dispatch
when the canonical task is terminal (`done`/`cancelled`) **and** post-approval has resolved
(the `task.status==='done'` guard in §6.6); (b) **delivery hard-fail** — only on **archive**
(the sole hard-failure condition — `cancelled` reopens, so there is no separate "hard-cancel"
signal; a user cancel that should discard handoffs archives the task), **not** on
run-`done`/`cancelled`; (c) **reopen prevention** — archive only. (v4 conflated (a)
and (b) by saying *all* durability consumers key off archive — that would strand a run whose
task is `done` but not yet archived; corrected.)

**Run-`done` ties to durable task-`done` (Phase 1e invariant):** today the run is set `done`
prematurely (`space-runtime.ts:7814`, before the post-approval/merger completes). Phase 1e
makes run-`done` coincide with the canonical task reaching durable `done` — not the
post-approval dispatcher return. (Mechanism deferred to the Phase 1e PR.)

### 3.2 Work item lifecycle — invariants

Statuses (match `NodeExecutionStatus`, `node-execution-manager.ts:39-67`): `pending |
in_progress | idle | waiting_rebind | blocked | cancelled`. Per-execution terminal = `idle |
cancelled` (no `done`; success parks as reactivatable `idle`). Invariants:

- **Lease on every activation:** every transition INTO `in_progress` — claim, idle/cancelled
  reactivation, blocked-resume — acquires a fresh lease + fencing token (§6.3).
- **Every non-archived item is reclaimable:** a crashed `in_progress` item returns to
  claimable via fenced lease-expiry (the one Phase-4 addition to
  `VALID_NODE_EXECUTION_TRANSITIONS`); `cancelled→in_progress` reactivates on run resume.
- **One attempt per freshly-leased invocation:** every activation that acquires a fresh lease
  (claim, idle/cancelled/blocked reactivation) appends exactly one attempt row;
  reset-to-pending does not.
- **Activation produces the complete declared slot set:** multi-slot node activation
  creates/reconciles every declared agent slot (atomic transaction or idempotent reconcile),
  not a short-circuit on the first active execution — so a crash mid-fan-out doesn't leave
  agents unactivated.

Exact transition wiring and attempt schema are Phase-4-PR mechanism.

### 3.3 Gate lifecycle — unchanged (closed→pending_approval→open; cyclic reset).

### 3.4 Delivery lifecycle (target)

| from | event | to | notes |
|---|---|---|---|
| `pending` | target activates | `delivered` | **receiver-side dedup** required (§6.2) — crash between inject and mark-delivered must not double-deliver |
| `pending` | TTL elapsed, attempts < max | `pending` (retry) | backoff |
| `pending` | max attempts | `failed` | **must propagate** to an actionable run/task state (dead-letter) — a `failed` row alone strands the workflow |
| `pending` | **task archived** (true tombstone) | `failed` | NOT on run `done`/`cancelled` (those reopen) |

**Gap (§6.1–6.2):** only inactive targets get a durable row today; live targets are
delivered directly with no durable row, so a crash between transition and live delivery
loses the handoff. The target table is the goal; the transactional-outbox phase reaches it.

### 3.5 Timer lifecycle — current + missing primitive

| type | trigger | effect | status |
|---|---|---|---|
| schedule (`task_schedules`) | cron/`run_at` | new run/task instance | exists |
| gate poll (`GatePoll`) | `intervalMs` | re-evaluate gate script | exists |
| hook retry | `next_retry_at` | re-run hook | exists |
| connector/gate retry (`GateRetryScheduler`) | `retryAfterMs` | re-evaluate gate | exists but **in-memory** (§6.3) |
| **in-run pause/resume** | wait-until / event | **resume the same run later** | **missing primitive** (§8.4) |

### 3.6 Approval lifecycle

`submit_for_approval` → task `review` → human `approve` → `approved` → post-approval route
→ `done` (`mark_complete`); reject → `in_progress`. **Post-approval dispatch must persist a
dispatch work-item BEFORE spawning** the sub-session (§6.6) — `postApprovalSessionId` is
the *output* of spawn (`post-approval-router.ts:113`) and is stamped only after spawn, so a
crash during spawn leaves no guard and recovery can spawn a second merger.

## 4. Workflow-definition schema (immutable, versioned, deletion-safe)

**Problems today (verified):**
1. Definitions are mutable (`updateWorkflow`); a run re-reads the live row each tick, so an
   edit silently changes an in-flight run.
2. `definition_version` is stamped on `pending→in_progress`, leaving a created-but-unstarted
   run unpinned (an edit/re-seed/tombstone before activation breaks the invariant).
3. Deleting a definition **orphans** runs: there is **no `workflow_id` FK** on
   `space_workflow_runs` (M60 rebuilt the table FK-free at `migrations.ts:4976`; M71
   preserved that shape at `:5810`; confirmed by the "Orphaned-run handling" comment at
   `:990`). `deleteWorkflow` (`space-workflow-manager.ts:445`) has no active-run guard, and
   other deletion paths bypass even that (import-replacement calls
   `workflowRepo.deleteWorkflow` directly; duplicate-resync calls
   `workflowRunRepo.deleteByWorkflowId`).

**Decision:**
1. `definition_version` = in-row content hash, **pinned on the run row at creation**
   (atomically with the initial run insert), with prior versions in an append-only
   `space_workflow_definition_versions` history table. (In-row avoids indirection on the
   hot-path `getWorkflow` reads.)
2. Built-in re-stamping becomes version-bumping, not in-place mutation. **Caveat (verified gap): built-in gate scripts are NOT pinned today** — `ChannelRouter.doEvaluateGate` (`channel-router.ts:1516`) overrides the stored gate script with `getBuiltInGateScript(workflow.templateName, …)` from the **current** template on every eval, so a template update changes an older run's gate behavior even with pinned reads. Phase 1 must resolve gate scripts from the **pinned template version** (or remove the live override); the pinning invariant does not hold for built-in gates until then.
3. **Deletion-safety (no cascade to "remove" — there is none):**
   - add a **not-archived guard** to **every** deletion/replacement path
     (`SpaceWorkflowManager.deleteWorkflow`, import-replacement, `deleteByWorkflowId`) —
     protect every run whose canonical task is **not archived** (including reopenable
     `done`/`cancelled`), not just currently-active statuses;
   - adopt an **orphan/tombstone policy** (soft-delete the definition; runs keep their
     pinned version);
4. **Read cutover + backfill (migration invariant):** a pin is inert unless run reads
   resolve through it — add a version-aware accessor used by every run read
   (`channel-router`, `space-runtime`), and at cutover **backfill every existing run whose
   canonical task is not archived** (including reopenable `done`/`cancelled`) — consistent
   with the §4.3 deletion guard — so pre-migration reopenable runs have a resolvable version
   and are not stranded. (Accessor shape / backfill SQL = Phase-1-PR scope.)
5. **Pinning boundary:** Phase 1 pins the **definition**. Referenced agent configs are a
   **separate mutable dependency** — `resolveAgentInit` loads the current agent at spawn
   (`custom-agent.ts:752`) — so the pinning contract must account for them (snapshot/version
   with the run); mechanism deferred to the Phase 1 PR.
   - add a **version-level FK** (runs reference a definition *version*, not the mutable
     head) once versioning lands.
4. `SpaceWorkflow` shape is otherwise unchanged.

## 5. Capability / connector contract (read-only today; mutating + imperative steps are new)

The contract serves today's **read-only** external-state lookups. It does **not** support
mutating ops or imperative steps:

```ts
type ConnectorOutcome = { ok: true; data: unknown }
  | { ok: false; error: string; retryable?: boolean; retryAfterMs?: number };
type ConnectorOp = (params: unknown, ctx: ConnectorContext) => Promise<ConnectorOutcome>;
interface Connector { id: string; ops: Record<string, ConnectorOp>; auth?: ConnectorAuth; }
```

**Gaps (verified):** no command idempotency key; no reconcile-unknown; and no
connector-action step type (connectors are validators/hooks only, `WorkflowNode.agents`
must be non-empty).

**Decision (before mutating/imperative connectors ship):**
- **Command idempotency key** on `ConnectorContext` derived from the **logical command
  identity** (run + work-item + step + op + params-hash) **plus an activation ordinal**,
  stable across every attempt, retry, and reconciliation — NOT derived from the attempt. The
  ordinal is essential: a `node_executions` row is **reused on `idle` reactivation**
  (including cyclic re-entry), so without it, a later *intentional* activation with the same
  params would hash identically and the remote would suppress the new refund/booking as a
  "retry." The ordinal is unique per logical activation, reused by all attempts of that
  activation.
- **Reconcile-unknown** semantics: a connector must answer "did this command already take
  effect?" so recovery confirms rather than blindly retries.
- **Connector capability/schema versioning:** the registry today allows an existing
  connector id to be overwritten; a durable action persisted under one implementation could
  be recovered/reconciled under a different one after an upgrade. Pin a connector
  capability/schema version **resolved and pinned at definition/run creation (not at
  action-creation) and retained until the task is archived** — so a run that reaches a
  connector node later, or reopens/cycles after a registry upgrade, still uses its
  creation-time versions (do not silently overwrite an in-use connector id).
- **Connector-action step primitive:** a new work-item/node kind that executes a connector
  op as a durable step with persisted inputs, outcome, retry, and reconciliation — so
  `shop.issueRefund` / `mes.fileDefect` / `travel.book` can run as definition steps, not as
  repeatedly-evaluated validators. (Phases in §9.)

## 6. Durability, transaction, and recovery model

### 6.1 Transactional outbox (target + verified gap)

**Target:** every transition is one SQLite transaction that atomically (1) validates the
guard (CAS `WHERE status=?` AND fencing token, §6.3), (2) writes status + append-only
attempt/transition rows, (3) **enqueues every resulting delivery (live + inactive)**, (4)
persists any retry deadline, (5) releases/acquires leases. This is the existing pattern for
cycle-increment + gate-reset (`channel-router.ts:1752`) but **not** for delivery: today the
gate write commits before `AgentMessageRouter.deliverMessage`, and live targets are
delivered with no durable row. The outbox phase makes delivery transactional.

### 6.2 Inbox/outbox + receiver-side dedup

- Outbox persisted in the transition transaction; `AgentMessageRouter` drains rows for live
  **and** inactive targets.
- Inbox idempotency today is a unique partial index on pending rows — but that prevents
  duplicate *rows*, not duplicate *dispatch*: if the dispatcher injects into a live session
  and crashes before marking the row delivered, restart re-injects. **Receiver-side dedup**
  (a delivery key the receiving session recognizes) or a durable ack is required before
  claiming live delivery is idempotent.

### 6.3 Leases/fencing + durable retry deadlines (verified gaps)

No lease/fencing today; `GateRetryScheduler` is in-memory (`Map`+`setTimeout`,
`gate-retry-scheduler.ts:10-11,34`) so a restart loses a rate-limit deadline and can strand
a non-polled gate.

- Claim = acquire `work_item_leases(work_item_id, owner, fencing_token, expires_at)` in the
  same transaction as `in_progress`; refresh on real SDK progress (addresses stranded-
  delivery class, #859–#862). **Every entry INTO `in_progress` acquires a fresh lease+token**
  — including `idle`/`cancelled` reactivation (which today bypass the `pending→in_progress`
  claim path and would otherwise run with no/stale token); mechanism deferred to Phase 4 PR.
- **Fencing scopes to leased-worker writes only:** a monotonic token invalidates a stale
  owner when every write made *on behalf of a leased worker* (transition, outbox enqueue,
  completion, connector-action outcome) compares the presented token against the current
  lease token (guarding only on `current_status` is insufficient — after reclaim, stale and
  new owners both see `in_progress`). **Unleased commands** — human/kernel actions
  (approval, cancellation, delivery failure, timer firing) — carry no lease and use
  status/generation guards, not fencing (so Phase 1b's outbox does not depend on Phase 4's
  leases).
- **Durable retry deadlines:** persist `retryAfterMs` to the timer/job model keyed by
  `(run, gate)`, rehydrated/cancelled on restart (not flag-gated — a lost deadline strands
  a gate).

### 6.4 Append-only attempts + transition audit (verified gap)

- Attempts (`node_execution_attempts`): one row per attempt, append-only.
- **Transition audit:** `workflow_run_artifacts` are upserts (`UNIQUE(...)`,
  `migrations.ts:6514`), not append-only; hook-result artifacts cover only hooks; attempts
  cover only work items. None records every run/task status change, approval, cancel,
  gate-reset, or routing transition. Add an append-only `workflow_transition_log`
  (+ actor + command metadata), or narrow the audit claim explicitly.

### 6.5 Recovery

`SpaceRuntimeService.start()` recovers (long-term inbox → `recoverStalledRuns`): skip if
in-flight; **finalize when the canonical task is terminal (`done`/`cancelled`) AND
post-approval has resolved** — consistent with §6.6's `task.status==='done'` guard. Archive
is a *separate* concern — the non-reopenable tombstone (§3.1), not the finalize trigger: a
crash after `mark_complete` (task `done`) but before the run-transition commits must not
strand the run. `reportedStatus`/`CompletionDetector` alone is not a finalize signal
(post-approval may still be in flight). GitHub-specific recovery + the full GitHub event
path move behind connector capabilities (Phase 5).

### 6.6 Idempotency summary (target mechanisms)

| Operation | Mechanism |
|---|---|
| Activate a node | reconcile the **complete declared slot set** (§3.2), idempotent — a crash mid-fan-out leaves no agent unactivated |
| Deliver a message | inbox unique key **+ receiver-side dedup / durable ack** |
| Claim a work item | lease CAS + fencing token checked on every **leased-worker** write (unleased human/kernel commands use status/generation guards) |
| Mutating connector op | command key (logical identity, stable across attempts) + reconcile-unknown |
| Post-approval dispatch | **persist dispatch work-item before spawn**; reconcile on recovery |
| Finalize run | task-status guard (re-entry short-circuits on `task.status==='done'`) |
| Gate open cache | `gate_open_state` + staleness guard |
| Connector/gate retry | persisted deadline, rehydrated on restart |

## 7. Compatibility map — current → target

| Current (domain-specific / gap) | Target | Strategy |
|---|---|---|
| `requireCodexApproval`/`codexPollIntervalMs`/`codexTimeoutSeconds` on 3 generic node types (`WorkflowNode` `space.ts:2287`, `WorkflowNodeInput` `:2321`, `ExportedWorkflowNode` `:2802`) + `effectiveNodes` projection (`space-workflow-manager.ts:314-316,325-327`) | `gateFeatureOverrides['codex_review_bot']` on all three + projection | dual-read; update all together; deprecated alias |
| `gate-features.ts` codex paths (`:36`–`:619`) + Codex validation (`space-workflow-manager.ts:559–646`) | `codex_review_bot` registered via `registerGateFeature` plugin | move to `gate-features/codex.ts` plugin |
| `pr_url` runtime handoff (`getPrUrlForRun` `channel-router.ts:363`, `PR_URL` env, `gate-evaluator.ts:563`, post-approval template) | per-run `runtime_context` map | dual-read; source = `gate_data`/hook-state/`workflow_run_artifacts` (`space_tasks` pr columns dropped in M84) |
| Full GitHub external-event path in `space-runtime.ts` (restart recovery, topic normalization, check-failure reopen, PR-URL match, auto-subscriptions, retained-event replay) | connector `recoverRun` + subscription/matching/reopen capabilities | Phase 5 |
| GitHub `post_review` tool (`postGitHubReview` via `gh api`) registered for **every** workflow end/approval-authority node via `isApprovalAuthorityNode` (`task-agent-manager.ts:4779`, block `:4762-4818`) + its schema (`node-agent-tool-schemas.ts:527`, registry `:623`) | node-declared connector tool capability (register generically from the definition, not by a hardcoded end-node predicate) | Phase 5 |
| Mutable definitions + unpinned created runs + **orphaning deletion** (no FK; guardless `deleteWorkflow` + bypass paths) | immutable + versioned + **pinned at creation** + deletion-safe | Phase 1: history table; pin at creation; guard **all** delete paths; orphan/tombstone policy; version-level FK |
| Inline crash-retry | append-only attempts + leases/fencing | Phase 4 (preserve idle/reactivation) |
| Live-target delivery non-durable; in-memory retry deadlines; upsert "audit" | transactional outbox + durable retries + transition log | Phases 1b/1c/1d |
| Mutating/imperative connectors unsupported | command-id + reconcile + connector-action step primitive | Phase 4b + 5b |
| In-run pause/resume timer missing | durable in-run wait/resume primitive | Phase 5c |
| `goals`/`mission_executions` — **documented compatibility surface, dormant at runtime** (CLAUDE.md L172-181 defines them as the Mission System; schema seeds them; `GoalRepository` exists) but **no live production writers** (`atomicStartExecution`/`insertExecution` have zero non-test callers; live automation uses `SpaceGoalRepository`→`space_goals`) | one active goal model above the engine | Phase 7: **treat as a compatibility surface** — audit must prove equivalence before any freeze/remove; assume neither fully-active nor safely-frozen |

**Already correct/untouched:** topology, agent slots + `toolGuards` + `eventInterests`,
gate field/script/validator/poll, channels + cycle caps, inactive-target durable delivery,
`gate_open_state`, `workflow_run_artifacts`, `task_schedules`/`job_queue`, connector
registry, LLM workflow selector, channel-send-as-activation + reopen semantics.

## 8. Reference workflows (expressiveness — honestly re-scoped)

Today's kernel fully expresses **agent-driven, validator-gated, schedule-triggered**
workflows. It does **not** yet express imperative connector-action steps or in-run
pause/resume timers. So:

- **PR review** — expressible today (`CODING_WORKFLOW`). Gates: `pr_ready`, `codex_review_bot`,
  human approval. Post-approval: PR Merger slot. Validated by existence.
- **Manufacturing defect / CAPA** — expressible today (agent triage/containment/CAPA nodes,
  `writers: []` QA gates, recurring `task_schedule` trend monitor, `mes.*` as
  validators/lookups). Connectors used read-only.
- **Ecommerce return** — needs the **connector-action primitive** (`shop.issueRefund`,
  `shop.restockItem` as durable mutating steps) + **mutating-connector idempotency**.
  Expressible *after* Phases 4b + 5b.
- **Personal travel** — needs the connector-action primitive **and** the **in-run
  pause/resume timer** (pre-trip reminder that resumes the same run). Expressible *after*
  Phases 4b + 5b + 5c.

**Conclusion (revised):** the definition+connector model is the right abstraction and needs
no redesign, but "fully expressive with zero kernel changes" was overstated. Two primitives
(connector-action steps, in-run timers) plus the durability cluster are required to cover
all four reference domains. Those primitives are phased (§9), not speculative — they are
forced by the reference workflows.

## 9. Phased roadmap

One compatibility-preserving PR per phase; shadow/flag first; migration + restart/concurrency
tests; explicit rollback. Durability + primitive phases precede the extractions/validations
that depend on them.

| Phase | Deliverable | Mode | Rollback |
|---|---|---|---|
| **0** (this RFC) | RFC + ADR, approval | docs | n/a |
| 1 | Immutable versioned definitions: `definition_version` pinned at run creation + `space_workflow_definition_versions` history; deletion-safe (guard all delete/replacement paths; orphan/tombstone; version-level FK); run reads resolve through the pinned version (not the mutable head) | shadow history; pin at creation | additive pins/history; readers revert only where live definition is provably equivalent (no `workflow_id` FK — no cascade to restore) |
| 1b | Transactional outbox: persist every delivery (live + inactive) in the transition; receiver-side dedup | write both; cutover when proven | drain per §11.8 |
| 1c | Durable connector/gate retry deadlines (rehydrate on restart) | new table/job type | drain per §11.8 |
| 1d | Append-only `workflow_transition_log` | append-only; opt-in readers | stop writing |
| 1e | Run-`done` ties to the canonical task reaching durable `done` (today premature, `space-runtime.ts:7814`) | behavior change guarded by flag; migration + tests | flag back to premature-`done` |
| 1f | Durable post-approval dispatch: persist the dispatch work-item BEFORE spawning the merger sub-session; reconcile on recovery — closes the spawn→stamp crash window that today lets recovery spawn a second merger (§3.6/§6.6) | new durability row | drain per §11.8 |
| 2 | Generic `runtime_context`; extract `pr_url` handoff | dual-read | flip back |
| 3 | Generic `gateFeatureOverrides`; extract `codex_review_bot` (3 type copies + projection **+ the export format**: `export-format.ts` validates/serializes only the legacy codex fields today, so the override must be added to `exportedWorkflowNodeSchema` + `exportWorkflow` or it's stripped on round-trip) | deprecated alias | alias honored |
| 4 | Append-only attempts + leases/**fencing on leased-worker writes** (flag-gated); preserve idle/reactivation | flag off = no-op | drain per §11.8 (active leases) |
| 4b | Mutating-connector readiness: command key (logical identity, stable across attempts) + reconcile-unknown | read-only connectors unaffected | capability flag |
| 5 | Full GitHub external-event path **+ the GitHub `post_review` outbound tool** (registered today for every end/approval-authority node via `isApprovalAuthorityNode` `task-agent-manager.ts:4779`, block `:4762-4818`; schema `node-agent-tool-schemas.ts:527`, registry `:623`) behind connector capabilities — node-declared tool grants, not hardcoded predicates | legacy retained until proven | fall back |
| 5b | **Connector-action step primitive** (durable connector-op steps; command key + activation ordinal; each action references the run-creation pin, §5) | new node/work-item kind behind flag | drain per §11.8 |
| 5c | **In-run pause/resume timer** primitive + recovery | new timer type | drain per §11.8 |
| 6 | ecommerce-return, manufacturing-defect, travel definitions + connectors as **in-tree `reference/` fixtures** (not seeded) + tests — using **sandbox/fake mutating connectors** with observable idempotent effects for ecommerce/travel (they're the workflows that forced connector-action + idempotency; read-only fixtures couldn't prove those primitives) | read-only; no production seeding | remove fixture |
| 7 | Goal-system unification audit (`goals`/`mission_executions` are dormant; decide migrate vs formal-freeze from evidence) | investigation + design first | n/a |

## 10. Deferred features

Subprocesses/nested calls; complex event correlation; distributed execution (leases are the
seam); compensation/saga (use corrective nodes); org/role modeling; visual designer/BPMN
import; process mining. (The premature run-`done` is NOT deferred — Phase 1e owns it.)

## 11. Migration safety invariants

1. A run executes its pinned definition version (pinned at **creation**); edits/deletions
   never mutate or orphan in-flight runs (Phase 1). **Upgrade invariant:** Phase 1 backfills
   a resolvable version for every pre-existing run (they pre-date the column) before the
   cutover/FK is enabled, so no active run is stranded.
2. No legacy removal before parity.
3. One invariant/capability per PR; each independently revertible.
4. Migration + restart/concurrency tests for every runtime change.
5. **Domain concepts never re-enter generic type/core paths** — acceptance `grep` (incl.
   `ExportedWorkflowNode`, `effectiveNodes`, the GitHub event-path symbols in
   `space-runtime.ts`) returns nothing outside adapters/plugins.
6. **Three distinct durability signals — don't conflate** (reconciles §3.1/§6.5/§6.6):
   **finalization** (release leases / stop timers) keys off task terminal (`done`/`cancelled`)
   + post-approval resolved; **delivery hard-fail** keys off archive or explicit hard-cancel
   (NOT run-`done`/`cancelled`, which reopen); **reopen-prevention / tombstone** =
   `SpaceTask.archivedAt` only.
7. **Idempotency keys are stable across attempts**; fencing tokens guard every
   **leased-worker** write (unleased human/kernel commands use status/generation guards).
8. **Rollback drains in-flight state, never a bare flag-flip:** any phase that creates
   durable state (outbox rows, retry deadlines, connector-action/timer instances, version
   pins) must, on rollback, keep the schema + dispatcher/worker readable and drain or
   migrate existing instances **before** removing execution support — a bare flag-flip
   strands persisted rows (outbox handoffs lost; persisted retry deadlines never fire after
   the in-memory scheduler restarts). Mechanism per phase PR.

## 12. Design-review decisions (resolved / revised across 3 rounds)

1. **Definition versioning** → in-row content hash **pinned at run creation** + append-only
   history table + **read cutover** (route run reads through the pinned version). **Deletion-
   safety** (no `workflow_id` FK — orphan, not erase; guard all delete paths + version-FK).
   **Phase 1e** delays run-`done` until post-approval resolves (v3 wrongly claimed `done` is
   post-`mark_complete`; verified `space-runtime.ts:7814` sets it before `dispatchPostApproval`).
2. **Lease scope** → flag-gated no-op for single-process; fencing token guards leased-worker
   writes only (unleased human/kernel commands use status/generation guards, §6.3);
   mutating-connector keys derive from logical command identity + activation ordinal
   (stable across attempts), with connector capability versions pinned at run creation (§5).
3. **Goal V2** → `goals`/`mission_executions` is a **documented compatibility surface,
   dormant at runtime** (CLAUDE.md L172-181 defines it as the Mission System; no live
   writers — `atomicStartExecution`/`insertExecution` have zero non-test callers; automation
   uses `SpaceGoalRepository`→`space_goals`). Phase 7 treats it as a compatibility surface:
   prove equivalence before any freeze/remove. *(v2 wrongly called it "active"; v3's
   "de-facto frozen" overstated it — corrected to compatibility surface.)*
4. **Reference workflows** → in-tree `reference/` fixtures, not seeded.
5. **Expressiveness (new)** → "zero kernel changes" re-scoped: connector-action steps
   (Phase 5b) and in-run timers (Phase 5c) are required new primitives for ecommerce/travel.

Phase 0 produces no code; upon approval, Phase 1 (+ durability cluster 1b–1d) begins.
