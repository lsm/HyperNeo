# ADR 0003: Data-Defined Workflow Engine

## Status

Proposed — Revision 11. All human + codex-connector review rounds to date; every
code-level claim re-verified directly against current source. States complete invariants +
phase boundaries; all mechanism deferred to phase PRs. Re-requesting review.
Phase 0 (architecture only); no runtime changes. Companion RFC:
`docs/design/workflow-engine-rfc.md`. Tracks goal task #874.

## Context

HyperNeo's Space workflow system is a capable agent-collaboration engine: a `SpaceWorkflow`
(nodes/channels/gates/hooks/post-approval) is interpreted by a generic runtime. The
**definition model and connector registry are already generic and data-defined** (no
`switch(workflowType/nodeType)` dispatch in core; connectors behind a flag).

However, the engine is **not** "fully expressive with zero kernel changes." A code survey
(verified directly, three rounds) found domain leakage **and** missing primitives/durability
a durable, domain-agnostic framework requires:

- **Domain leakage:** `requireCodexApproval`/`codexPollIntervalMs`/`codexTimeoutSeconds` on
  three generic node types (`WorkflowNode` `space.ts:2287`, `WorkflowNodeInput` `:2321`,
  `ExportedWorkflowNode` `:2802`) + the `effectiveNodes` projection
  (`space-workflow-manager.ts:314-316,325-327`); codex compiler across `gate-features.ts`
  (`:36`–`:619`); the `pr_url` runtime handoff (`getPrUrlForRun` `channel-router.ts:363`,
  `PR_URL` env, `gate-evaluator.ts:563`); the full GitHub external-event path in
  `space-runtime.ts` (recovery, topic normalization, check-failure reopen, PR-URL match,
  auto-subscriptions, retained-event replay); and the GitHub `post_review` tool
  (`postGitHubReview` via `gh api`) registered for every workflow end/approval-authority
  node via `isApprovalAuthorityNode` (`task-agent-manager.ts:4779`, block `:4762-4818`)
  with its schema (`node-agent-tool-schemas.ts:527`, registry `:623`).
- **Missing primitives (verified):** imperative connector-action steps — connectors are
  read-only validators/hooks only (`external-state-validator.ts:84`, `hook-executor.ts:203`)
  and `WorkflowNode.agents` must be non-empty, so `issueRefund`/`fileDefect`/`book` cannot
  run as durable steps; and an in-run pause/resume timer (`task_schedules` make new runs,
  `GatePoll` re-evaluates, hook-retries retry — none pauses/resumes one run).
- **Durability gaps (verified):** no transactional outbox (live targets bypass the durable
  inbox; gate write commits before delivery); in-memory retry deadlines
  (`GateRetryScheduler`, `gate-retry-scheduler.ts:10-11,34`); upsert "audit"
  (`workflow_run_artifacts` `UNIQUE(...)`, not append-only); mutable/unpinned definitions
  (runs re-read the live row each tick; `definition_version` not stamped at creation);
  **no `workflow_id` FK** on `space_workflow_runs` (M60 rebuilt it FK-free; M71 preserved
  that) so deletion **orphans** runs, and `deleteWorkflow` (`:445`) + import-replacement +
  `deleteByWorkflowId` all lack an active-run guard; no mutating-connector idempotency;
  `postApprovalSessionId` stamped only after spawn (`post-approval-router.ts:113`) so a
  spawn-time crash can double-dispatch the merger.
- **Terminal semantics (verified):** `done`/`cancelled` **reopen** to `in_progress`
  (`workflow-run-status-machine.ts`); the only tombstone is `SpaceTask.archivedAt`. Run-`done`
  is **premature today** — set at `space-runtime.ts:7814` before `dispatchPostApproval`
  (`:7858`), so the run is `done` while the merger still runs (Phase 1e delays it).
- **Goal model:** `space_goals` is the active model; `goals`/`mission_executions` is
  **dormant/legacy** (schema `index.ts:405` labels it legacy; `atomicStartExecution`/
  `insertExecution` have zero non-test callers; the live automation handler uses
  `SpaceGoalRepository`→`space_goals`).

## Decision

Adopt the foundational rule:

> **Data-defined behavior, code-defined semantics, plugin-defined capabilities.**

- **Data-defined behavior.** All workflow-specific behavior lives in immutable, versioned
  definitions; the kernel never branches on which workflow is running.
- **Code-defined semantics.** The generic kernel owns transitions, durable work items and
  append-only attempts, leases/fencing, idempotency, approvals, timers, inbox/outbox
  delivery, retries, recovery, audit, and terminal semantics.
- **Plugin-defined capabilities.** Domain actions are connectors invoked by id. Workers
  (agents/humans/services) execute work items; sessions are resources, not identity.

Concretely, **accept the RFC's phased plan** (§9): extraction **plus** new primitives
**plus** a durability cluster.

1. Immutable, versioned, **deletion-safe** definitions pinned **at run creation** (guard all
   delete/replacement paths; orphan/tombstone policy; version-level FK — there is no
   `workflow_id` FK to "remove").
2. Generic `runtime_context` (extract the `pr_url` handoff; `space_tasks` pr columns already
   dropped in M84).
3. Generic `gateFeatureOverrides` (codex → plugin; all three node-type copies + projection).
4. Append-only attempts + leases/**fencing on leased-worker writes only** (unleased
   commands use status/generation guards, §6.3; preserve idle/reactivation).
5. Full GitHub external-event path **+ the GitHub `post_review` outbound tool** behind
   connector capabilities (node-declared tool grants, not the hardcoded
   `isApprovalAuthorityNode` predicate).
6. Reference definitions as in-tree `reference/` fixtures.
7. Goal-system unification audit — legacy tables are a **documented compatibility surface,
   dormant at runtime** (CLAUDE.md L172-181; no live writers); treat as a compatibility
   surface until equivalence is proven (not "de-facto frozen").

Durability cluster: **1b** transactional outbox + receiver-side dedup; **1c** durable retry
deadlines; **1d** append-only `workflow_transition_log`; **4b** mutating-connector command
idempotency (key = logical command identity, stable across attempts) + reconcile-unknown.

New primitives: **5b** connector-action step (durable connector-op steps); **5c** in-run
pause/resume timer. These are forced by the ecommerce/travel reference workflows (§8), not
speculative.

Each phase is one compatibility-preserving PR behind adapters/flags, with migration tests and
explicit rollback. **No big-bang rewrite; no silent reinterpretation of active runs; no
legacy removal before parity.**

## Consequences

**Positive**

- Domain-agnostic execution: adding a domain = authoring a definition + connectors (agent-
  driven/validator-gated/scheduled workflows need no kernel change; ecommerce/travel need
  the phased primitives).
- The durability cluster closes the stranded-delivery (#859–#862) and lost-handoff classes
  and makes recovery observable and auditable.
- Definition versioning + deletion-safety make in-flight runs immune to edits and to
  orphaning.
- Mutating-connector idempotency makes ecommerce/travel side effects crash-safe.

**Negative**

- Two new kernel primitives (connector-action steps, in-run timers) plus a durability
  cluster — more new code than pure extraction.
- Phases of dual-read/dual-write adapters to maintain until parity.
- Leases/fencing must be tested under crash, duplicate-wake, concurrent-claim, restart.

**Neutral**

- The dormant `goals`/`mission_executions` tables coexist with `space_goals` until the
  Phase 7 audit decides their fate.
- Terminology is unchanged where already correct (Run, Work item, Gate, Channel).

## Design-review decisions (resolved/revised across 3 rounds)

1. **Definition versioning** → in-row content hash **pinned at run creation** + append-only
   history table + **read cutover** (run reads resolve through the pinned version, not the
   mutable head). **Deletion-safety** (no `workflow_id` FK — orphan, not erase; guard all
   delete paths + version-FK). **Phase 1e** delays run-`done` until post-approval resolves
   (today `space-runtime.ts:7814` sets `done` before `dispatchPostApproval`).
2. **Lease scope** → flag-gated no-op for single-process; fencing token guards
   **leased-worker writes only** (unleased human/kernel commands use status/generation
   guards, §6.3); mutating-connector keys derive from logical command identity + activation
   ordinal (stable across attempts); connector capability versions pinned at run creation (§5).
3. **Goal V2** → `goals`/`mission_executions` is a **documented compatibility surface,
   dormant at runtime** (CLAUDE.md L172-181 defines it as the Mission System; no live
   writers). Phase 7 treats it as a compatibility surface: prove equivalence before freeze/remove.
4. **Reference workflows** → in-tree `reference/` fixtures, not seeded.
5. **Expressiveness** → "zero kernel changes" re-scoped: connector-action steps (5b) and
   in-run timers (5c) are required new primitives for ecommerce/travel.
