# ADR 0003: Data-Defined Workflow Engine

## Status

Proposed — awaiting design review. Phase 0 (architecture only); no runtime changes.
Companion RFC: `docs/design/workflow-engine-rfc.md`. Tracks goal task #874.

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
- Goal V2 (`space_goals`) is already layered cleanly above the engine as a "what/when"
  trigger/spec layer, while `SpaceWorkflow` is the "how" execution-definition layer.

However, the remaining ~15% is **domain-specific (GitHub/PR/Codex) logic leaking into the
generic type and core paths**, and single-process execution let us defer two durability
seams. Concretely:

- `WorkflowNode.requireCodexApproval` / `codexPollIntervalMs` / `codexTimeoutSeconds` are
  first-class fields on the **generic** shared type (`packages/shared/src/types/space.ts:2287`,
  duplicated at `:2321`), with a ~300-line Codex feature compiler in
  `gate-features.ts` and Codex-specific validation in `space-workflow-manager.ts:559–646`.
- `pr_url` is an implicit handoff contract threaded through the channel router
  (`getPrUrlForRun`, `channel-router.ts:363`), gate-script env (`PR_URL`),
  `gate-evaluator.ts:563`, the post-approval template context, and the
  `space_tasks.pr_url` / `pr_number` / `pr_created_at` columns. (Migration 84's stated
  intent was already to replace these columns with `workflow_run_artifacts` —
  `migrations.ts:380` — confirming the canonical direction, but the extraction is
  incomplete.)
- Daemon-restart recovery has a GitHub-specific path
  (`rehydrateActiveRunPrEventSubscriptions`, `space-runtime-service.ts:2523`).
- There are **no leases or fencing tokens**: single-process SQLite transactions suffice
  today, but the seams needed for multi-worker durability (and for cleanly resolving the
  recurring "stranded message delivery" class, tasks #859–#862) are absent.
- Definitions are mutable; an edit can silently change the behavior of an in-flight run.

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
  Messages communicate; explicit outcomes/signals/commands advance process state.

Concretely, **accept the RFC's phased extraction plan** (`docs/design/workflow-engine-rfc.md` §9):

1. Immutable, versioned definitions pinned on runs.
2. Generic `runtime_context` map replacing the `pr_url` implicit contract.
3. Generic `gateFeatureOverrides` replacing `requireCodexApproval` / the codex feature.
4. Append-only attempts + leases/fencing (flag-gated).
5. Connector-declared `recoverRun` hook replacing GitHub-specific recovery.
6. Reference definitions (ecommerce return, manufacturing defect, travel) proving
   genericity.
7. Retire the legacy `room/` Mission System after parity.

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
- Leases + fencing + append-only attempts close the durability gap that produces stranded
  message delivery (#859–#862) and make recovery observable and auditable.
- Definition versioning makes in-flight runs immune to silent behavior changes from edits.
- Goal V2 is validated as the correct trigger layer above a generic execution engine.

**Negative**

- Several phases of dual-read/dual-write code and adapters to maintain until parity is
  proven and the legacy path is removed — near-term complexity for long-term cleanliness.
- Leases/fencing add a new subsystem; even flag-gated, it must be tested under crash,
  duplicate-wake, and concurrent-claim scenarios.
- Reference workflows (Phase 6) add fixture/test surface that must be maintained.

**Neutral**

- The `room/` legacy Mission System is frozen, not deleted; retirement is gated on parity
  evidence and a quiet period (Phase 7).
- Terminology is intentionally unchanged where the current vocabulary is already correct
  (Run, Work item, Gate, Channel) to keep the migration incremental and the diff
  reviewable.

## Open questions (deferred to review of the RFC)

See RFC §12: definition-version storage shape; whether leases are required in the
single-process path now or strictly flag-gated; whether legacy goals are migrated or
frozen; whether reference workflows ship in-tree or as a separate examples package.
