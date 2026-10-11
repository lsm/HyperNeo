# Space Autonomy & Human-in-the-Loop Gap Analysis

Date: 2026-04-12  
Last updated: 2026-04-15

## Architecture Summary

The space/task/workflow system has three orthogonal control layers:

| Layer | Scope | Mechanism | Key File |
|-------|-------|-----------|----------|
| **Gates** | Per-channel in workflow | Field checks + scripts block message delivery | `runtime/gate-evaluator.ts` |
| **Autonomy Level** | Per-space | Controls task terminal status (`review` vs `done`) and gates completion-action execution | `runtime/space-runtime.ts` → `resolveCompletionWithActions` |
| **Task Status Machine** | Per-task | `open -> in_progress -> review -> done` | `managers/space-task-manager.ts` |

### How Autonomy Works Today

Autonomy has exactly **one policy function** — `resolveCompletionWithActions` in `space-runtime.ts` — invoked from two completion paths (the single-task and multi-node-run branches of the tick loop). Levels (1–5) decide both the terminal task status and which completion actions auto-execute:

```
level 1:          workflow completes -> task status = 'review' (human must approve)
level >= 2:       workflow completes -> task status = 'done' if autonomy >= every action's requiredLevel
                                       else 'review' paused at first action whose requiredLevel exceeds autonomy
```

During execution, all levels behave identically; only the terminal resolution differs.

---

## Room vs Space: Architectural Guidelines for Gap Fixes

Room and Space both orchestrate agent work, but their architectures differ in a way
that must guide every implementation decision in this gap list.

| | Room | Space |
|---|------|-------|
| **Workflow model** | Static, hardcoded in code — the code *is* the workflow (leader/worker/planner roles wired directly in `room-runtime.ts`) | Framework — users define workflow topology (nodes, channels, gates) as data; the runtime executes it generically |
| **Boundary** | No clear boundary between execution logic and workflow definition | Clean separation: workflow definition (data) vs. workflow executor (runtime) |
| **Extension point** | Add a new role → modify runtime code | Add a new node/channel → modify workflow data, runtime unchanged |

### Implications for gap fixes

1. **Keep execution details out of the workflow executor.** The workflow executor
   (`workflow-executor.ts`, `channel-router.ts`, `gate-evaluator.ts`) is generic
   infrastructure. Gap fixes that add scheduling logic, retry policies, or
   autonomy-aware behavior belong at the **task scheduling layer**
   (`space-runtime.ts` tick loop, `space-task-manager.ts`), not inside the executor.

2. **Prefer passive re-evaluation over explicit cascading.** Space already has a
   5-second tick loop that re-evaluates all open tasks. When possible, let the tick
   naturally discover state changes (e.g., dependencies met) rather than building
   explicit unblock/notify cascades. This keeps the system simpler and idempotent.

3. **Don't copy Room patterns verbatim.** Room's tight coupling (e.g., role-specific
   logic in `submit_for_review()`, hardcoded `leader_semi_auto` approval source)
   works *because* Room's workflow is static. Space must express the same intent
   through its existing extensibility primitives (gates, channels, task metadata)
   rather than hardcoding role-specific behavior.

4. **Cross-pollinate concepts, not code.** Room's richer autonomy model (planner
   always needs human, coder auto-approves) is a useful *design reference* for
   Gap #4 and #7. But the implementation should use Space's gate/channel system
   to express these policies declaratively, not replicate Room's imperative checks.

---

## Gap List

### 1. PR Auto-Merge for Semi-Autonomous ✅

**Status:** Implemented (completion actions + workflow templates)

PR merge is now handled via two complementary mechanisms:
- **Short workflows** (Coding, Research): `MERGE_PR_COMPLETION_ACTION` on the end node's `completionActions[]` — a script completion action (`requiredLevel: 4`) that squash-merges via `gh pr merge --squash` and syncs the worktree
- **Long workflows** (Full-Cycle, Fullstack QA): QA node prompt includes merge + worktree sync steps (merge is part of the QA validation, not a separate node)
- **Completion action execution loop** in `SpaceRuntime.resolveCompletionWithActions()` — iterates actions in order, auto-executes when `space.autonomyLevel >= action.requiredLevel`, pauses task at `review` with `pendingActionIndex` otherwise
- **Gate auto-approval** via `requiredLevel` on gates — `plan-approval-gate` migrated from `writers: ['human']` to `writers: ['reviewer']` + `requiredLevel: 3`

Remaining:
- No gate script template for "wait for N approvals + CI green" (separate from merge logic)

**Impact:** High  
**Effort:** Medium

---

### 2. Approval Notification/Queue UI ✅ PR #1491

Gates support `writers: ['human']` and `spaceWorkflowRun.approveGate` RPC exists. However:
- ~~No notification to tell humans a gate is waiting~~
- ~~No inbox/queue of pending approvals in the UI~~
- No webhook/Slack/email integration for approval requests
- ~~Human must manually check the workflow run state to discover pending gates~~

**Implemented:**
- Shared `isActionRequired` predicate (`packages/web/src/lib/task-filters.ts`) — single source of truth that classifies a task as needing action when its status is `review` or `blocked` (any block reason)
- "Action" tab in SpaceTasks — groups tasks by reason: Needs Input, Gate Pending, Awaiting Review, Blocked
- Amber attention badge on Tasks sidebar button and SpacesPage cards, derived from the same predicate over the live `spaceStore.tasks` LiveQuery (no separate server-side attention query)

**Impact:** Medium — humans don't know when approval is needed  
**Effort:** Medium

---

### 2b. Action UI (Approve/Reject/Resolve) ✅ PR #1493

~~Gap #2 surfaces *that* tasks need human attention, but there is no UI for *taking* that action.~~

~~Missing:~~
- ~~Approve/reject buttons for gate-pending tasks (`spaceWorkflowRun.approveGate` RPC exists but has no UI)~~
- Input form for `human_input_requested` tasks (agent asked a question, human has no way to answer)
- ~~"Mark done" / "Re-open" actions for tasks in `review` status~~
- ~~Contextual display of *why* the task is blocked (gate message, agent's question, dependency chain)~~

**Implemented:**
- `TaskBlockedBanner` component with distinct UI per `blockReason` (6 reason types)
- Gate approval flow: `gate_rejected` banner → "Review & Approve" → `GateArtifactsView` inline with diff review + approve/reject
- `listGateData` and `approveGate` wired to frontend `spaceStore`

**Depends on:** Gap #2 (notification/queue), Gap #8 (block reasons)  
**Impact:** High — without action UI, the notification queue is informational only  
**Effort:** Medium

---

### 3. Approval Audit Trail ✅ PR #1481

~~When a human approves a gate or transitions a task from `review` -> `done`:~~
- ~~No record of **who** approved or **when**~~
- ~~No approval comment/reason field~~
- ~~Room system tracks `approvalSource` (`"human"` vs `"leader_semi_auto"`) but space system doesn't~~
- ~~No audit log for gate state changes~~

**Implemented:**
- `SpaceApprovalSource` type — simplified to `human | auto_policy | agent` (PR #1502 collapsed 6 sub-types into 3; agent identity tracked in session metadata)
- `approvalSource`, `approvalReason`, `approvedAt` stamped on SpaceTask and gate data at every code path
- `approve_gate` tool added to Space Agent and Task Agent; `approve_task` tool added to Space Agent
- Approval metadata cleared on task reactivation (done → in_progress)

**Impact:** Medium — no accountability  
**Effort:** Low

---

### 4. Execution-Time Autonomy Differentiation

~~Semi-autonomous is identical to supervised during execution.~~ Partially addressed:
- ✅ Gate auto-approval: gates with `requiredLevel` auto-approve when `space.autonomyLevel >= requiredLevel` (channel-router)
- ✅ Completion actions: end-node actions auto-execute or pause based on `requiredLevel` vs space level
- ✅ Agent prompt differentiation: level ≥ 3 grants autonomous retry/reassign (space-chat-agent)
- Autonomy-aware retry behavior (semi-autonomous retries more aggressively)
- Autonomous decision-making at workflow branch points

**Impact:** High — partially addressed by gate auto-approval and completion actions  
**Effort:** High (remaining items)

---

### 5. Task Dependency Enforcement ✅ PR #1488

~~`SpaceTask.dependsOn` stores dependency IDs but is **not enforced at runtime**:~~
- ~~Tasks with unmet deps can be started~~
- ~~No auto-blocking when dependencies incomplete~~
- ~~No auto-unblocking when dependencies complete~~
- ~~`cancelTaskCascade()` exists for cancellation propagation but no `completionCascade()` for unblocking~~

**Implemented:**
- `areDependenciesMet()` check at scheduling time — tasks with unmet deps stay `open`
- DFS-based circular dependency detection on create and update
- Cancelling a task settles its dependents through `settleTaskDependents` (open ones blocked with `dependency_failed`, running ones stopped); a blocked task changes nothing downstream (#6313)
- Dependency ID validation on `updateTask()` (was only on create)

**Impact:** Medium  
**Effort:** Medium

---

### 6. Tiered Retry by Autonomy Level

Current behavior when a node agent crashes (same for both modes):
- Runtime detects via liveness check
- Resets node to `pending` for retry
- After max retries, escalates to `blocked`

Missing autonomy-aware retry policies:
- **Semi-autonomous:** Auto-retry more aggressively (higher retry count, auto-restart)
- **Supervised:** Block immediately and notify human on first failure

**Impact:** Medium  
**Effort:** Medium

---

### 7. Room/Space Autonomy Unification

Two parallel autonomy systems exist with different capabilities:

| System | Table | Check Point | Behavior |
|--------|-------|-------------|----------|
| Space | `spaces.autonomy_level` | Workflow task completion | Binary: review vs done |
| Room/Goal | `goals.autonomy_level` | `submit_for_review()` | Richer: planner always needs human, coder auto-approves with `leader_semi_auto` |

No cross-pollination of patterns between the two systems.

**Impact:** High — confusing dual systems  
**Effort:** High

---

### 8. Block Reason Tagging for Space Tasks ✅ PR #1486

~~Space tasks use a single `blocked` status for all failure modes. Once a task is blocked,
nothing in the system knows *why* — the UI, notifications, retry logic, and Space Agent
all see the same opaque state.~~

**Approach:** Keep `blocked` as the only status. Add a `blockReason` field that records
the specific cause. Downstream systems (notifications, retry, autonomy) branch on the
reason, not the status.

**Implemented block reasons (by code path):**

| Reason | Trigger | Who resolves | Auto-recoverable? |
|--------|---------|-------------|-------------------|
| `agent_crashed` | Agent session died after 2 retries | Space Agent `retry_task()` → human | No (retries exhausted) |
| `workflow_invalid` | Missing endNodeId or broken topology | Human (fix workflow definition) | No |
| `execution_failed` | Node hit unrecoverable error | Space Agent → human | No |
| `human_input_requested` | Task Agent called `request_human_input` | Human (answer the question) | No (by design) |
| `gate_rejected` | Human or agent rejected a gate | Human (re-approve or revise) | No |
| `dependency_failed` | Upstream task failed (Gap #5) | Depends on upstream fix | No |

**Implemented:**
- 6 structured `blockReason` types with `stampBlockReason()` / `clearBlockReason()` API
- `gate_rejected` wired into approval gate rejection flow
- `dependency_failed` wired into dependency cascade (PR #1488)

**Why not a separate `needs_attention` status?**
- No status machine changes, no migration of existing tasks
- Block reasons are more informative than a binary status split
- The runtime auto-retry (2 agent crashes, 1 run retry) happens *before* `blocked` — by the
  time a task is blocked, auto-recovery already failed regardless of reason
- UI/notifications can filter on reason directly (e.g. show badge only for `human_input_requested` + `gate_rejected`)

**Impact:** Low-Medium  
**Effort:** Low

---

### 9. Human Review SLA/Timeout

Tasks can sit in `review` indefinitely:
- No configurable SLA per space
- No auto-escalation after timeout
- No auto-approve option for semi-autonomous after timeout period

**Impact:** Low  
**Effort:** Low

---

### 10. Conditional Branching by Autonomy

Workflow topology is fixed regardless of autonomy level:
- Can't express "if supervised, route to human-review node; if semi-autonomous, skip to merge node"
- Would need conditional node type or autonomy-aware channel routing

**Impact:** Medium  
**Effort:** High

---

### 11. Runtime Lifecycle Controls (Start/Pause/Resume) ✅

~~SpaceRuntime has `start()` and `stop()` methods but they are internal-only — no RPC handlers, no UI controls. There is no pause/resume concept at all.~~

**Implemented:**
- `paused` boolean field on Space (migration 85)
- `space.pause` / `space.resume` RPC handlers with `space.updated` event emission
- Tick loop skips paused spaces: `listActiveSpaces()` filters them out, `processRunTick` checks `space.paused`
- `SpaceStore.pauseSpace()` / `resumeSpace()` frontend methods
- `RuntimeControlBar` in SpaceOverview with Pause/Resume buttons
- `runtimeState` signal derived from `space.paused` + `space.status`

**Impact:** High — users cannot control execution flow  
**Effort:** Low-Medium

---

### 12. Autonomy Level UI Toggle (Manual/Semi-Auto/Full-Auto) ✅

**Status:** Implemented (backend: PR #1502, UI: PR #1503)

The autonomy model has been upgraded from binary (`supervised` / `semi_autonomous`) to a 5-level numeric scale (`SpaceAutonomyLevel = 1 | 2 | 3 | 4 | 5`). Types, DB schema (migration 86), runtime, agent tools, and UI are all implemented.

**Implemented:**
- `SpaceAutonomyLevel = 1 | 2 | 3 | 4 | 5` — numeric levels with operator-assigned semantics
- Runtime auto-completes tasks at level >= 2; agent prompt grants autonomous corrective actions at level >= 3
- `SpaceSettings.tsx` — 5-option button group with level descriptions, part of the save/discard form
- `SpaceOverview.tsx` — compact 5-segment bar with color coding (blue/amber/red), instant save via `spaceStore.updateSpace()`
- Backend validation via `VALID_AUTONOMY_LEVELS` in `space.update` and `space.create` RPC handlers

Remaining (out of scope, tracked separately):
- Per-task autonomy override (some tasks need human review even in higher-autonomy spaces)

**Impact:** Medium  
**Effort:** Low (UI-only)

---

### 13. No Dead Loop Detection in Spaces

**Status:** Not implemented — *unblocked by completion-semantics rewrite*

Room has `dead-loop-detector.ts` (Levenshtein similarity-based, 5-fail threshold within 5-minute window)
that detects infinite gate bounce cycles and escalates to human. Space has nothing equivalent —
an agent can crash/retry indefinitely within the fixed retry budget, and the runtime has no
intelligence to detect that repeated failures share the same root cause.

Current Space retry behavior:
- `MAX_TASK_AGENT_CRASH_RETRIES = 2` — fixed count, no pattern analysis
- `MAX_BLOCKED_RUN_RETRIES = 1` — fixed count
- After exhausting retries → `blocked` with `agent_crashed` reason — but no diagnostic of *why*

Missing:
- **Stall detection**: with the new completion model (`idle`/`cancelled` are NOT completion
  signals; only canonical `task.status` is), the runtime can now distinguish "all nodes idle +
  no pending activations + task still in_progress + no `reportedStatus`" → **stalled**, not
  complete. Previously this state was misread as completion. See `completion-detector.ts` TODO
  marker for the entry point.
- Similarity detection across failure reasons (are retries hitting the same error?)
- Escalation with diagnostic summary (what was the agent trying when it failed?)
- Configurable thresholds per space or workflow

**Impact:** Medium — stuck workflows consume resources without meaningful escalation  
**Effort:** Medium

---

### 14. No PR Merge Validation in Spaces ✅

**Status:** Implemented

PR validation in spaces is handled via two mechanisms in the built-in workflow templates:

1. **End node instructions** — Reviewer/QA prompts now include explicit PR verification steps
   before calling `report_result()`. The agent can react if the PR isn't in the expected state
   (e.g. resolve conflicts, re-push).

2. **Completion action failure blocks task** — `executeCompletionAction()` now returns
   success/failure. If a completion action script (e.g. `merge_pr`) fails, the task transitions
   to `blocked` instead of silently completing as `done`. This is a framework-level fix that
   applies to all completion actions, not just PR merge.

Unlike Room's `lifecycle-hooks.ts` approach (400+ lines of imperative checks baked into the
runtime), Space uses its existing gate/channel/completion-action primitives. PR validation is
workflow template data, not framework code — users can customize or remove it.

**Impact:** High — tasks no longer complete without verifying work was integrated  
**Effort:** Low (workflow data + one runtime behavior change)

---

### 15. No Unified Inbox for Space Approvals

**Status:** Not implemented

The global `Inbox` component (`packages/web/src/components/inbox/Inbox.tsx`) aggregates room tasks
in `review` status with approve/reject buttons. Space tasks and gate approvals are **not included**.

Space approval discoverability relies on:
- Attention badge on sidebar Tasks button (per-space only, not global)
- SpacesPage cards showing "N action" count
- Must navigate into the specific space → Tasks → Action tab → click task → banner

For users managing multiple spaces, there is no single view of all pending approvals across spaces.

**Impact:** Medium — approval discoverability scales poorly with number of spaces  
**Effort:** Low-Medium

---

### 16. Multi-Gate Blocking Ambiguity

**Status:** Known limitation (comment in code)

`TaskBlockedBanner.tsx:111` has a TODO comment:
> "in multi-gate workflows this may not be the gate that actually blocked the task.
> A future improvement would store `blockingGateId` on SpaceTask to remove ambiguity."

When a task is blocked with `gate_rejected`, the UI picks the first rejected/waiting gate from
`listGateData()`. In workflows with multiple gates, this heuristic may show the wrong gate.

Missing:
- `blockingGateId` field on `SpaceTask` stamped when `gate_rejected` block reason is set
- Runtime passes the specific gate ID that caused the rejection through to `stampBlockReason()`
- `TaskBlockedBanner` uses the stored ID instead of heuristic search

**Impact:** Low — only affects multi-gate workflows  
**Effort:** Low

---

### 17. Consecutive Failure Escalation in Spaces

**Status:** Not implemented

Room has per-goal `consecutiveFailures` counter with `maxConsecutiveFailures` threshold (default 3).
When the threshold is reached, the goal is escalated to `needs_human` status. On success, the
counter resets to 0.

Space has **no equivalent**. The fixed retry budget (`MAX_TASK_AGENT_CRASH_RETRIES = 2`) applies
equally regardless of history. There is no concept of "this space/task keeps failing, escalate
to human" beyond the per-task retry exhaustion.

Missing:
- Per-space or per-task consecutive failure counter
- Configurable failure threshold before escalation
- Counter reset on success
- Escalation action (pause space? notify human? mark space as `needs_human`?)

**Depends on:** Gap #6 (tiered retry), Gap #13 (dead loop detection)  
**Impact:** Medium  
**Effort:** Low-Medium

---

### 18. Task Retry RPC

**Status:** Not implemented

With the new completion-semantics rewrite, an unrecoverably blocked end-node leaves
`task.status = 'blocked'` (with `blockReason='execution_failed'` or `'agent_crashed'`)
and the workflow run is `blocked`. Humans/agents can already use `task.update` to mark
the task `cancelled`, `done`, or `archived` — but there is no equivalent for "retry":
re-spawn the end-node execution and flip the task back to `in_progress`.

Workaround today: cancel the task and start a new workflow run from scratch. This
discards any partial progress (other node executions, gate artifacts, send_message
history) and forces re-planning.

Missing:
- `task.retry` RPC handler that resets blocked node executions to `pending`, clears
  the task's blocked state, and resumes the existing workflow run
- UI affordance on `TaskBlockedBanner` to invoke retry
- Bound on retry attempts to prevent infinite loops (overlaps with Gap #6)

**Depends on:** Gap #6 (retry semantics), Gap #13 (stall/loop detection for retry budget)  
**Impact:** Medium — currently humans must restart workflows from scratch  
**Effort:** Low-Medium

---

### 19. End-Node Single-Agent Invariant (Documented)

**Status:** Implemented and enforced — *invariant for future workflow authoring*

End nodes own the workflow's completion signal via `report_result` (the only signal
the runtime accepts as workflow completion). Multi-agent end nodes create ambiguity
about who declares the workflow done — there are no quorum semantics defined and a
race condition would result.

Enforcement: `space-workflow-manager.ts::validateEndNodeId()` rejects workflow
definitions whose end node has anything other than exactly 1 agent. All built-in
workflows comply (single-agent Reviewer/QA at the end).

Future workflow authors must respect this invariant; consider it part of the
"workflow design contract" alongside the reachability and channel-validity rules.

**Impact:** Documentation/invariant — prevents future bugs  
**Effort:** Done

---

## Priority Matrix

| # | Gap | Impact | Effort | Priority | Status |
|---|-----|--------|--------|----------|--------|
| 1 | PR auto-merge for semi-autonomous | High | Medium | **P0** | ✅ |
| 2 | Approval notification/queue UI | Medium | Medium | **P1** | ✅ PR #1491 |
| 2b | Action UI (approve/reject/resolve) | High | Medium | **P1** | ✅ PR #1493 |
| 3 | Approval audit trail | Medium | Low | **P1** | ✅ PR #1481 |
| 4 | Execution-time autonomy differentiation | High | High | **P2** | Partial |
| 5 | Task dependency enforcement | Medium | Medium | **P2** | ✅ PR #1488 |
| 6 | Tiered retry by autonomy level | Medium | Medium | **P2** | |
| 7 | Room/Space autonomy unification | High | High | **P3** | |
| 8 | Block reason tagging for space tasks | Low-Medium | Low | **P2** | ✅ PR #1486 |
| 9 | Human review SLA/timeout | Low | Low | **P3** | |
| 10 | Conditional branching by autonomy | Medium | High | **P3** | |
| 11 | Runtime lifecycle controls | High | Low-Medium | **P1** | ✅ |
| 12 | Autonomy level UI toggle | Medium | Medium | **P2** | ✅ |
| 13 | Dead loop detection in spaces | Medium | Medium | **P2** | |
| 14 | PR merge validation in spaces | High | Medium | **P1** | ✅ |
| 15 | Unified inbox for space approvals | Medium | Low-Medium | **P2** | |
| 16 | Multi-gate blocking ambiguity | Low | Low | **P3** | |
| 17 | Consecutive failure escalation | Medium | Low-Medium | **P2** | |
| 18 | Task retry RPC | Medium | Low-Medium | **P2** | |
| 19 | End-node single-agent invariant | n/a | Done | n/a | ✅ |

## Dependency Graph & Implementation Order

```
Gap 3 (Audit Trail) ──────┐
                           ├──► Gap 2 (Notification UI) ──► Gap 2b (Action UI) ──► Gap 14 (PR Merge Validation) ──► Gap 1 (PR Auto-Merge)
Gap 8 (Block Reasons) ────┘                                       │
                                                                  ├──► Gap 15 (Unified Inbox)
Gap 5 (Dependency Enforcement)                                    ├──► Gap 16 (Multi-Gate Ambiguity)
                                                                  ▼
                                                          Gap 17 (Consecutive Failure Escalation)
                                                                  │
                                                    ┌─────────────┼─────────────┐
                                                    ▼             ▼             ▼
                                              Gap 6 (Retry)  Gap 13 (Dead Loop)  Gap 9 (Review SLA)
                                                    │             │
                                                    └──────┬──────┘
                                                           ▼
                                                    Gap 4 (Execution-Time Autonomy)
                                                           │
                                                           ▼
                                                    Gap 10 (Conditional Branching)
                                                           │
                                                           ▼
                                                    Gap 7 (Room/Space Unification)

Gap 12 (Autonomy UI Toggle) — standalone, no dependencies
```

### Recommended Implementation Sequence

| Step | Gap | Why this order | Effort | Status |
|------|-----|----------------|--------|--------|
| 1 | **#3 Audit trail** | Foundation — everything else needs to record who/when/why | Low | **Done** (PR #1481) |
| 2 | **#8 Block reason tagging** | Foundation — distinguishes block types for notifications & retry | Low | **Done** (PR #1486) |
| 3 | **#5 Dependency enforcement** | Standalone, no deps, fixes correctness issue | Medium | **Done** (PR #1488) |
| 4 | **#2 Notification UI** | Builds on 3+8, unlocks human-in-the-loop usability | Medium | **Done** (PR #1491) |
| 5 | **#2b Action UI** | Builds on #2, makes notification queue actionable | Medium | **Done** (PR #1493) |
| 6 | **#16 Multi-gate ambiguity** | Small fix, improves gate_rejected UX accuracy | Low | |
| 7 | **#12 Autonomy UI toggle** | Quick win — users can't configure autonomy without this | Medium | **Done** |
| 8 | **#17 Consecutive failure escalation** | Foundation for smarter retry/escalation, low effort | Low-Medium | |
| 9 | **#6 Tiered retry** | Builds on #17, informed by block reason distinction | Medium | |
| 10 | **#13 Dead loop detection** | Builds on #17, prevents stuck workflows | Medium | |
| 11 | **#14 PR merge validation** | Correctness — tasks shouldn't complete without verifying PR state | Medium | **Done** |
| 12 | **#1 PR auto-merge** | Builds on #14, needs merge verification + audit trail + action UI | Medium | **Done** |
| 13 | **#15 Unified inbox** | Cross-space discoverability, builds on notification UI pattern | Low-Medium | |
| 14 | **#9 Review SLA** | Small, builds on audit trail | Low | |
| 15 | **#4 Execution-time autonomy** | Builds on retry + block reasons + failure escalation | High | |
| 16 | **#10 Conditional branching** | Extends execution-time autonomy into workflow topology | High | |
| 17 | **#7 Room/Space unification** | Last — needs both systems mature before merging patterns | High | |

### Related Infrastructure Changes

| PR | Change | Gaps affected |
|----|--------|---------------|
| #1464 | Replace `done`/`report_done`/`write_gate` with `idle`/`save`/auto-gate-write | #2b (gate flow) |
| #1496 | Workflow run artifacts — typed node outputs replacing task-level PR fields | #1 (PR auto-merge prerequisite) |

## Key Files Reference

| Component | Path |
|-----------|------|
| Space types | `packages/shared/src/types/space.ts` |
| Space runtime | `packages/daemon/src/lib/space/runtime/space-runtime.ts` |
| Gate evaluator | `packages/daemon/src/lib/space/runtime/gate-evaluator.ts` |
| Channel router | `packages/daemon/src/lib/space/runtime/channel-router.ts` |
| Task manager | `packages/daemon/src/lib/space/managers/space-task-manager.ts` |
| Space agent tools | `packages/daemon/src/lib/space/tools/space-agent-tools.ts` |
| Task agent tools | `packages/daemon/src/lib/space/tools/task-agent-tools.ts` |
| Node agent tools | `packages/daemon/src/lib/space/tools/node-agent-tools.ts` |
| Node agent tool schemas | `packages/daemon/src/lib/space/tools/node-agent-tool-schemas.ts` |
| Workflow executor | `packages/daemon/src/lib/space/runtime/workflow-executor.ts` |
| Session notification sink | `packages/daemon/src/lib/space/runtime/session-notification-sink.ts` |
| Workflow run artifacts repo | `packages/daemon/src/storage/repositories/workflow-run-artifact-repository.ts` |
| Space RPC handlers | `packages/daemon/src/lib/rpc-handlers/space-*.ts` |
| Task blocked banner (UI) | `packages/web/src/components/space/TaskBlockedBanner.tsx` |
| Space tasks list (UI) | `packages/web/src/components/space/SpaceTasks.tsx` |
| Gate artifacts view (UI) | `packages/web/src/components/space/GateArtifactsView.tsx` |
| Space store | `packages/web/src/lib/space-store.ts` |
| Room runtime (comparison) | `packages/daemon/src/lib/room/runtime/room-runtime.ts` |
| Room lifecycle hooks (comparison) | `packages/daemon/src/lib/room/runtime/lifecycle-hooks.ts` |
| Room dead loop detector (comparison) | `packages/daemon/src/lib/room/runtime/dead-loop-detector.ts` |
| Room agent tools (comparison) | `packages/daemon/src/lib/room/tools/room-agent-tools.ts` |
| Global inbox (room-only) | `packages/web/src/components/inbox/Inbox.tsx` |
