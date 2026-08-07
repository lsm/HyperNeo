# ADR 0003: Data-Defined Workflow Engine

## Status

Proposed — Revision 2. Architecture approved in design review (PR #2396); the human
review's doc-accuracy fixes and the codex-connector inline review (which surfaced several
P1 durability gaps) are incorporated, all claims re-verified against code. Re-requesting
review. Phase 0 (architecture only); no runtime changes. Companion RFC:
`docs/design/workflow-engine-rfc.md`. Tracks goal task #874.

## Context

HyperNeo's Space workflow system has organically become a capable agent-collaboration
engine: a `SpaceWorkflow` (nodes / channels / gates / hooks / post-approval routes) is
interpreted by a generic runtime that drives runs by activating work items, evaluating
gates, and routing durable messages. A code survey for this RFC found that the engine is
already **~85% data-defined**:

- There is no `switch(workflowType)` / `switch(nodeType)` dispatch in the core runtime.
  Topology, gate evaluation, cycle caps, completion detection, and post-approval routing
  are all data-driven.
- A clean connector abstraction already exists
  (`packages/daemon/src/lib/space/runtime/connectors/`) — `Connector` / `ConnectorOp` /
  `ConnectorOutcome` / `ConnectorAuth` behind a generic registry — and the connector layer
  is being rolled out behind a feature flag (`isConnectorsLayerEnabled()`).
- Goal V2 (`space_goals`) is layered above the engine as a "what/when" trigger/spec layer,
  while `SpaceWorkflow` is the "how" execution-definition layer. **Note:** there is a second,
  also-active goal model — the room-era `goals`/`mission_executions` "Mission System"
  (`goal-repository.ts`, driven by `goal-automation-execute.handler.ts`) — whose relationship
  to `space_goals` is unresolved; it is **not** legacy (see Decision 7).

However, the remaining work is larger than "extract GitHub." There is domain-specific
(GitHub/PR/Codex) logic leaking into the generic type and core paths, **and** several
durability guarantees a "durable execution framework" requires are not yet met by the
current single-process code. The codex-connector inline review surfaced the latter; all
points below were re-verified against the code:

- `WorkflowNode.requireCodexApproval` / `codexPollIntervalMs` / `codexTimeoutSeconds` are
  first-class fields on the **generic** node types (`packages/shared/src/types/space.ts`:
  `WorkflowNode` `:2287`, `WorkflowNodeInput` `:2321`, **and `ExportedWorkflowNode` `:2802`**
  the portable export format), plus an `effectiveNodes` projection in
  `updateWorkflow` (`space-workflow-manager.ts:314-316, 325-327`) that copies them through.
  The codex feature compiler dominates `gate-features.ts` (codex paths span `:36`–`:619` of
  631 lines), with Codex-specific validation in `space-workflow-manager.ts:559–646`.
- `pr_url` is an implicit **runtime handoff** threaded through the channel router
  (`getPrUrlForRun`, `channel-router.ts:363`), gate-script env (`PR_URL`),
  `gate-evaluator.ts:563`, and the post-approval template context. The `space_tasks.pr_url`
  columns were **already dropped** in migration 84 (`runMigration84`, `migrations.ts:6514`,
  replaced by `workflow_run_artifacts`); only the runtime handoff remains to extract.
- The full GitHub external-event path (restart recovery `rehydrateActiveRunPrEventSubscriptions`,
  topic normalization, check-failure reopening, PR-URL matching, auto-subscriptions,
  retained-event replay) lives in `space-runtime.ts`, not just restart recovery.
- **No transactional outbox:** `send_message` commits the gate write before delivery, and
  **live targets are delivered directly with no durable row** (only inactive targets hit
  `pending_agent_messages`). A crash between the transition and live delivery opens the gate
  but loses the handoff.
- **No leases or fencing tokens**, and connector/gate **retry deadlines are in-memory only**
  (`GateRetryScheduler`, `gate-retry-scheduler.ts:10-11,34`) — a restart loses a rate-limit
  deadline and can strand a non-polled gate indefinitely.
- **No append-only transition audit:** `workflow_run_artifacts` are upserts
  (`UNIQUE(...)`), not append-only; nothing records every status/approval/cancel/gate-reset/
  routing transition.
- **Definition deletion is unsafe:** `space_workflow_runs.workflow_id` is `ON DELETE CASCADE`
  and `deleteWorkflow` (`space-workflow-manager.ts:445`) has no active-run guard — deleting a
  definition erases in-flight runs. (Definitions are also mutable, so an edit can silently
  change an in-flight run.)
- **Mutating connectors have no idempotency:** `ConnectorContext`/`ConnectorOp` carry no
  command key or reconcile-unknown semantics; a crash after a remote `issueRefund`/`book`
  succeeds but before the SQLite commit would duplicate the side effect.
- **Terminal-vs-completion conflation:** `CompletionDetector.isComplete` returns true on
  `reportedStatus != null`; the RFC must not treat that as terminal for leases/timers/
  delivery, since approval and post-approval work may still be in flight.
- **Work-item lifecycle:** `NodeExecutionStatus` has no `done`; terminal = `idle | cancelled`,
  and successful turns become reactivatable `idle` rows.

The goal (#874) is to make this a **domain-agnostic, durable execution framework** —
usable for business processes, manufacturing, ecommerce, personal-assistant workflows, and
agent collaboration — with a strictly incremental, compatibility-first migration.

## Decision

Adopt the foundational rule:

> **Data-defined behavior, code-defined semantics, plugin-defined capabilities.**

- **Data-defined behavior.** All workflow-specific behavior lives in immutable, versioned
  **definitions** (topology, transitions, prompts, policies, approval thresholds, delivery
  targets, timers). The kernel interprets definitions and **never branches on which
  workflow is running.**
- **Code-defined semantics.** The generic kernel owns the *meaning* of transitions,
  durable work items and append-only attempts, roles/actor assignment, authorization,
  leases, idempotency, approvals, timers, inbox/outbox delivery, retries, recovery, audit,
  and terminal semantics. These are universal.
- **Plugin-defined capabilities.** Domain actions (GitHub, ecommerce, MES, travel) are
  **connectors** in a generic capability registry, invoked by id. Agents, humans, and
  services are **workers**; sessions are execution *resources*, not workflow identity.
  Channel-directed sends and explicit outcomes/commands advance process state; untargeted
  free text only communicates.

Concretely, **accept the RFC's phased plan** (`docs/design/workflow-engine-rfc.md` §9),
which is extraction **plus** a durability cluster that closes the verified gaps first:

1. Immutable, versioned, **deletion-safe** definitions pinned on runs (tombstone/version-FK
   + active-run guard; remove the `workflow_id` cascade).
2. Generic `runtime_context` map replacing the `pr_url` runtime handoff (PR data already in
   `workflow_run_artifacts` post-M84).
3. Generic `gateFeatureOverrides` replacing `requireCodexApproval` / the codex feature
   (all three node-type copies + the `effectiveNodes` projection).
4. Append-only attempts + leases/fencing (flag-gated), **preserving the idle/reactivation
   work-item lifecycle**.
5. Full GitHub external-event path behind connector capabilities (`recoverRun` +
   subscription/matching/reopen), not just restart recovery.
6. Reference definitions (ecommerce return, manufacturing defect, travel) as in-tree
   `reference/` fixtures proving genericity.
7. **Goal-system unification audit** — determine the relationship between
   `goals`/`mission_executions` and `space_goals` from evidence; **do not freeze or retire**
   either (the Mission System is active).

Durability cluster (new, closes verified gaps): **1b** transactional outbox (persist every
delivery — live + inactive — in the transition transaction); **1c** durable connector/gate
retry deadlines (rehydrate on restart); **1d** append-only `workflow_transition_log`;
**4b** mutating-connector command idempotency + reconcile-unknown.

Each phase is one compatibility-preserving PR behind adapters/feature flags, with dual-read
where needed, migration tests, and explicit rollback criteria. **No big-bang rewrite; no
silent reinterpretation of active runs; no legacy removal before parity evidence.**

## Consequences

**Positive**

- The engine becomes usable for arbitrary domains without core changes — adding ecommerce,
  manufacturing, or travel workflows means authoring a definition + connector, not editing
  the kernel.
- Existing workflows keep running unchanged throughout; the migration is bounded extraction,
  not a rewrite, because the model is already largely correct.
- Leases + fencing + append-only attempts + transactional outbox + durable retry deadlines
  close the durability gaps that produce stranded message delivery (#859–#862) and lost
  handoffs, and make recovery observable and auditable.
- Definition versioning + deletion-safety make in-flight runs immune to silent behavior
  changes from edits **and** to erasure from definition deletion.
- Mutating-connector idempotency makes ecommerce/travel-style side effects safe under crash.
- The goal trigger layer sits cleanly above a generic execution engine.

**Negative**

- Several phases of dual-read/dual-write code and adapters to maintain until parity is
  proven and the legacy path is removed — near-term complexity for long-term cleanliness.
- Leases/fencing add a new subsystem; even flag-gated, it must be tested under crash,
  duplicate-wake, and concurrent-claim scenarios.
- Reference workflows (Phase 6) add fixture/test surface that must be maintained.

**Neutral**

- Two goal models (`goals`/`mission_executions` and `space_goals`) coexist for now; their
  unification is deferred to an evidence-driven audit (Phase 7), not assumed.
- Terminology is intentionally unchanged where the current vocabulary is already correct
  (Run, Work item, Gate, Channel) to keep the migration incremental and the diff
  reviewable.

## Design-review decisions (resolved / revised)

From the review of PR #2396 (see RFC §12); all re-verified against code.

1. **Definition versioning** → in-row content hash (`definition_version`) pinned on the run
   + append-only `space_workflow_definition_versions` history table (avoids indirection on
   hot-path `getWorkflow` reads). **Plus deletion-safety** (added after verification showed
   the `ON DELETE CASCADE` + guardless `deleteWorkflow` gap): tombstone/version-FK retaining
   referenced versions + an active-run guard.
2. **Lease scope** → flag-gated no-op for the single-process path; enforced only when a
   second worker exists.
3. **Goal V2 unification** → ~~freeze legacy read-only~~ **REVERSED.** Verification shows
   `goals`/`mission_executions` is an **active** Mission System (`goal-repository.ts`,
   `atomicStartExecution`, monotonic `execution_number`, driven by
   `goal-automation-execute.handler.ts`), not legacy. The "freeze" decision rested on an
   unverified premise; it is replaced by an evidence-driven unification **audit** (Phase 7)
   with no freeze or retirement in the meantime.
4. **Reference workflows** → in-tree under a marked `reference/`/fixtures path, not seeded.
