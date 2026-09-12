# Space Autonomy & Human-in-the-Loop Gap Analysis

Date: 2026-04-12
Last updated: 2026-04-27

## Architecture Summary

The space/task/workflow system has three orthogonal control layers:

| Layer | Scope | Mechanism | Key File |
|-------|-------|-----------|----------|
| **Gates** | Per-channel in workflow | Field checks + scripts block message delivery | `runtime/gate-evaluator.ts` |
| **Autonomy Level** | Per-space | Controls task terminal status and post-approval routing | `runtime/space-runtime.ts` → `PostApprovalRouter` |
| **Post-Approval Routing** | Per-workflow end-node | After human approval, dispatches sub-session (e.g. merge PR) | `runtime/post-approval-router.ts` |
| **Task Status Machine** | Per-task | `open -> in_progress -> review -> approved -> done` | `managers/space-task-manager.ts` |

### How Autonomy Works Today

Autonomy has multiple enforcement surfaces across the runtime:

1. **Task completion resolution** in `space-runtime.ts` — when a workflow's end node calls `report_result`, the runtime checks `space.autonomyLevel >= workflow.completionAutonomyLevel`:
   - Below threshold → task status = `review` (human must approve)
   - At/above threshold → task auto-transitions through `approved` to `done`

2. **Post-approval routing** in `post-approval-router.ts` — after human approval (or auto-approval at high autonomy), the router dispatches a post-approval sub-session to a target agent defined by the workflow's `postApproval` route (e.g., reviewer merges the PR). The agent calls `mark_complete` when done.

3. **Gate auto-approval** in `channel-router.ts` — gates with `requiredLevel` auto-approve when `space.autonomyLevel >= requiredLevel` during inter-node routing.

4. **Agent prompt gating** in `task-agent-manager.ts` — end-node agents receive `approve_task()` tool only when `spaceLevel >= workflow.completionAutonomyLevel`; otherwise they get `submit_for_approval()` instead.

5. **`approved` transient status** — new task status between `review` and `done`. Tasks enter `approved` when a human approves (or the runtime auto-approves at sufficient autonomy). The post-approval sub-session executes while the task is `approved`, then transitions to `done` via `mark_complete`.

Shared logic lives in `packages/shared/src/space/workflow-autonomy.ts` (`isWorkflowAutoClosingAtLevel()` — single pure function checking `level >= (wf.completionAutonomyLevel ?? 5)`).

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

**Status:** Implemented (post-approval routing + workflow templates)

PR merge is handled via post-approval routing. When a task completes and the workflow defines a `postApproval` route, the `PostApprovalRouter` dispatches a sub-session to a target agent (typically the reviewer) with instructions to merge the PR. The agent calls `mark_complete` when done.

- **PR-producing workflows** (Coding, Research, Coding with QA): `postApproval` targets the reviewer agent with merge instructions via `post-approval-merge-template.ts`
- **Decomposition workflow** (Plan & Decompose): End node dispatches standalone tasks via `create_standalone_task`; no post-approval route needed
- **Autonomy gating**: at `space.autonomyLevel >= workflow.completionAutonomyLevel`, the runtime auto-approves (skips `review`, goes straight to `approved` → post-approval sub-session → `done`). Below threshold, the human approves first.
- **Gate auto-approval** via `requiredLevel` on gates — `plan-approval-gate` uses `requiredLevel: 3`
- **Task status flow**: `in_progress` → `review` (if human needed) → `approved` → post-approval sub-session → `done`

Previous implementation used `CompletionAction` types (`script`/`instruction`/`mcp_call`) with `requiredLevel` — deleted in PRs #1620–#1628 (April 24). Replaced by the simpler `PostApprovalRouter` + `mark_complete` model.

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

~~Semi-autonomous is identical to supervised during execution.~~ Significantly addressed:

**Implemented:**
- ✅ Task completion resolution: `space.autonomyLevel >= workflow.completionAutonomyLevel` determines whether task auto-closes or pauses at `review`
- ✅ Post-approval routing: `PostApprovalRouter` dispatches post-approval sub-session (e.g. merge PR) after approval; auto-approves at sufficient autonomy
- ✅ Gate auto-approval: gates with `requiredLevel` auto-approve when `space.autonomyLevel >= requiredLevel` (channel-router, fires during inter-node routing)
- ✅ Agent prompt gating: end-node agents receive `approve_task()` only when `spaceLevel >= workflow.completionAutonomyLevel`; otherwise get `submit_for_approval()` (task-agent-manager)
- ✅ Agent prompt differentiation: level ≥ 3 grants autonomous retry/reassign (space-chat-agent)
- ✅ Notification context: `SessionNotificationSink` includes `autonomyLevel` in every notification
- ✅ Shared autonomy logic: `workflow-autonomy.ts` provides `isWorkflowAutoClosingAtLevel()` used by both runtime and UI

**Still missing:**
- Autonomy-aware retry behavior (semi-autonomous retries more aggressively) — fixed retry constants regardless of level
- Autonomous decision-making at workflow branch points (message routing is not autonomy-differentiated)
- Per-task autonomy override

**Impact:** High — core autonomy surfaces implemented, retry/routing gaps remain
**Effort:** Medium (remaining items)

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
- `blockDependentTasks()` cascades `dependency_failed` block reason to open dependents on failure/cancel
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
| Space | `spaces.autonomy_level` | Workflow task completion, gate auto-approval, completion actions | 5-level numeric (`1..5`) with per-action `requiredLevel` and shared `workflow-autonomy.ts` logic |
| Room/Goal | `goals.autonomy_level` | `submit_for_review()` | Binary: `supervised` / `semi_autonomous` — planner always needs human, coder auto-approves with `leader_semi_auto` |

Space has been upgraded to a richer model than what the Room system offers, but there is no shared abstraction between the two. `workflow-autonomy.ts` is Space-only; Room has not been upgraded. Cross-pollination is one-directional.

**Remaining:**
- Shared autonomy abstraction that both Room and Space consume
- Room upgrade from binary to multi-level
- Unified configuration UI

**Impact:** High — two divergent systems, but Space is now richer than Room
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

~~Workflow topology is fixed regardless of autonomy level.~~ Implicit autonomy-conditional routing exists:

**Implemented (implicit):**
- Gate `requiredLevel` + channel-router auto-approval: a gated channel auto-opens when `spaceLevel >= gate.requiredLevel`, effectively routing around the gate at higher autonomy
- `CompletionAction.requiredLevel` on end nodes: at low autonomy the task pauses at `review` for human approval; at high autonomy it auto-completes
- `workflow.completionAutonomyLevel`: controls which tools the end-node agent receives

**Still missing:**
- General-purpose conditional nodes ("if autonomy >= 3, take this edge; else take that edge")
- Autonomy-aware condition evaluation in `workflow-executor.ts` (currently supports `always`, `human`, `condition`, `task_result` — none consider autonomy)

**Impact:** Medium — implicit routing covers many practical cases
**Effort:** Medium-High (remaining: general conditional nodes)

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

**Status:** Not implemented — *prerequisite landed, ready to implement*

Room has `dead-loop-detector.ts` (Levenshtein similarity-based, 5-fail threshold within 5-minute window)
that detects infinite gate bounce cycles and escalates to human. Space has nothing equivalent —
an agent can crash/retry indefinitely within the fixed retry budget, and the runtime has no
intelligence to detect that repeated failures share the same root cause.

Current Space retry behavior:
- `MAX_TASK_AGENT_CRASH_RETRIES = 2` — fixed count, no pattern analysis
- `MAX_BLOCKED_RUN_RETRIES = 1` — fixed count
- After exhausting retries → `blocked` with `agent_crashed` reason — but no diagnostic of *why*
- `channel-router.ts` enforces `maxCycles` on cyclic channels, preventing infinite back-loops

The completion-semantics rewrite has landed. `CompletionDetector` inspects canonical `SpaceTask` (not `NodeExecution`), supporting both `task.status` terminal states and `reportedStatus` signals. The prerequisite described below is now fully in place.

Missing:
- **Stall detection**: the `CompletionDetector` can now distinguish "all nodes idle +
  no pending activations + task still in_progress + no `reportedStatus`" → **stalled**, not
  complete. See `completion-detector.ts` TODO marker (lines 26–29) for the entry point.
- Similarity detection across failure reasons (are retries hitting the same error?)
- Escalation with diagnostic summary (what was the agent trying when it failed?)
- Configurable thresholds per space or workflow

**Impact:** Medium — stuck workflows consume resources without meaningful escalation  
**Effort:** Medium

---

### 14. No PR Merge Validation in Spaces ✅

**Status:** Implemented

PR validation happens at two layers:

1. **End node instructions** — Reviewer/QA prompts include explicit PR verification steps
   before calling `report_result()`. The agent can react if the PR isn't in the expected state
   (e.g. resolve conflicts, re-push).

2. **Post-approval routing** — `PostApprovalRouter` dispatches a post-approval sub-session targeting the reviewer with merge instructions. If the merge fails, the task transitions to `approved` with `postApprovalBlockedReason` set, surfaced via `PendingPostApprovalBanner`. The reviewer can retry or a human can mark done.

Unlike Room's `lifecycle-hooks.ts` approach (400+ lines of imperative checks baked into the
runtime), Space uses post-approval routing + gate/channel primitives. PR validation is
workflow template data, not framework code.

**Impact:** High — tasks no longer complete without verifying work was integrated
**Effort:** Low (workflow data + post-approval routing)

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

`TaskBlockedBanner.tsx:80` has a TODO comment:
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

**Status:** Partially implemented

**Implemented (daemon-internal):**
- `SpaceTaskManager.retryTask()` method — accepts taskId + optional description, transitions `blocked`→`open`, `cancelled`/`done`→`in_progress`. Documented as "daemon-internal method called by Space Agent MCP tools (not exposed via RPC handlers)."
- Space Agent `retry_task` MCP tool — invokes `retryTask()` for the Space Agent to retry blocked tasks autonomously
- Automatic runtime retry via `attemptBlockedRunRecovery()` — resets blocked node executions to `pending`, transitions run back to `in_progress`, emits `task_retry` notifications with attempt numbers. After `MAX_BLOCKED_RUN_RETRIES=1`, emits `workflow_run_needs_attention`.
- Generic status transitions via `TaskStatusActions` — `blocked→open` ("Reopen"), `blocked→in_progress` ("Resume") buttons as workaround

**Missing:**
- `spaceTask.retry` RPC handler — no public API for the web client to invoke retry
- Dedicated "Retry" UI button on `TaskBlockedBanner` (current workaround: generic status transitions)
- Bound on retry attempts for manual/MCP retries to prevent infinite loops (overlaps with Gap #6)

**Depends on:** Gap #6 (retry semantics), Gap #13 (stall/loop detection for retry budget)
**Impact:** Medium — daemon-internal retry works; humans lack a direct retry button
**Effort:** Low (RPC handler + UI button only)

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
| 4 | Execution-time autonomy differentiation | High | Medium | **P2** | Partial |
| 5 | Task dependency enforcement | Medium | Medium | **P2** | ✅ PR #1488 |
| 6 | Tiered retry by autonomy level | Medium | Medium | **P2** | |
| 7 | Room/Space autonomy unification | High | High | **P3** | Partial |
| 8 | Block reason tagging for space tasks | Low-Medium | Low | **P2** | ✅ PR #1486 |
| 9 | Human review SLA/timeout | Low | Low | **P3** | |
| 10 | Conditional branching by autonomy | Medium | Medium-High | **P3** | Partial |
| 11 | Runtime lifecycle controls | High | Low-Medium | **P1** | ✅ |
| 12 | Autonomy level UI toggle | Medium | Medium | **P2** | ✅ |
| 13 | Dead loop detection in spaces | Medium | Medium | **P2** | Unblocked |
| 14 | PR merge validation in spaces | High | Medium | **P1** | ✅ |
| 15 | Unified inbox for space approvals | Medium | Low-Medium | **P2** | |
| 16 | Multi-gate blocking ambiguity | Low | Low | **P3** | |
| 17 | Consecutive failure escalation | Medium | Low-Medium | **P2** | |
| 18 | Task retry RPC | Medium | Low | **P2** | Partial |
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
| #1505 | Completion-semantics rewrite: canonical task status as sole completion signal | #13 (prerequisite) |
| #1516 | Autonomy-gated agent approvals: per-field writers-vs-autonomy two-path model | #4 (execution autonomy) |
| #1517 | Workflow template drift detection + sync from template | Infrastructure |
| #1533 | `report_result` result-only; completion pipeline sole status arbiter | #13 (prerequisite) |
| #1537 | "X of Y workflows autonomous" on autonomy selector (`AutonomyWorkflowSummary`) | #12 (autonomy UI) |
| #1539 | Plan & Decompose workflow replaces Full-Cycle | #1 (workflow templates) |
| #1541 | Allow communication until task is archived (node session reachability) | Infrastructure |
| #1547 | `send_message_to_task` targets any workflow node (auto-spawn + activate) | Infrastructure |
| #1551 | Background job queue + cache for artifact git ops | Infrastructure |
| #1552 | Split `report_result` into audit/approve/submit — end reviewer-loop premature completion | #3 (audit trail), #4 (execution autonomy) |
| #1620–#1628 | Delete completion-action pipeline; replace with `PostApprovalRouter` + `approved` status + `mark_complete` tool | #1, #4, #14 |
| #1645 | Treat tasks in `review`/`approved` as at-rest in `recoverSingleRun` (daemon restart recovery) | Infrastructure |
| #1677 | Fix post-approval workflow prompts (reviewer instructions) | #1 |
| #1678 | Fix Space runtime MCP rehydration across daemon restart | Infrastructure |

### Architectural Evolution

| Phase | Period | Key Mechanism | Status |
|-------|--------|---------------|--------|
| **v1: Binary autonomy** | Pre-April 2026 | `supervised` / `semi_autonomous` → task status `review` / `done` | Superseded |
| **v2: Completion actions** | April 15–24 | 5-level autonomy + `CompletionAction` types (`script`/`instruction`/`mcp_call`) with `requiredLevel` | Deleted (#1620–#1628) |
| **v3: Post-approval routing** | April 24+ | 5-level autonomy + `PostApprovalRouter` + `postApproval` workflow routes + `approved` transient status + `mark_complete` tool | **Current** |

## Key Files Reference

| Component | Path |
|-----------|------|
| Space types | `packages/shared/src/types/space.ts` |
| Shared autonomy logic | `packages/shared/src/space/workflow-autonomy.ts` |
| Space runtime | `packages/daemon/src/lib/space/runtime/space-runtime.ts` |
| Post-approval router | `packages/daemon/src/lib/space/runtime/post-approval-router.ts` |
| Post-approval merge template | `packages/daemon/src/lib/space/workflows/post-approval-merge-template.ts` |
| Completion detector | `packages/daemon/src/lib/space/runtime/completion-detector.ts` |
| Gate evaluator | `packages/daemon/src/lib/space/runtime/gate-evaluator.ts` |
| Channel router | `packages/daemon/src/lib/space/runtime/channel-router.ts` |
| Session notification sink | `packages/daemon/src/lib/space/runtime/session-notification-sink.ts` |
| Task manager | `packages/daemon/src/lib/space/managers/space-task-manager.ts` |
| End-node handlers | `packages/daemon/src/lib/space/tools/end-node-handlers.ts` |
| Space agent tools | `packages/daemon/src/lib/space/tools/space-agent-tools.ts` |
| Task agent tools | `packages/daemon/src/lib/space/tools/task-agent-tools.ts` |
| Node agent tools | `packages/daemon/src/lib/space/tools/node-agent-tools.ts` |
| Node agent tool schemas | `packages/daemon/src/lib/space/tools/node-agent-tool-schemas.ts` |
| Workflow executor | `packages/daemon/src/lib/space/runtime/workflow-executor.ts` |
| Built-in workflow templates | `packages/daemon/src/lib/space/workflows/built-in-workflows.ts` |
| Artifact git ops | `packages/daemon/src/lib/space/artifact-git-ops.ts` |
| Report result repository | `packages/daemon/src/storage/repositories/space-task-report-result-repository.ts` |
| Artifact cache repository | `packages/daemon/src/storage/repositories/workflow-run-artifact-cache-repository.ts` |
| Workflow run artifacts repo | `packages/daemon/src/storage/repositories/workflow-run-artifact-repository.ts` |
| Artifact job handler | `packages/daemon/src/lib/job-handlers/space-workflow-run-artifact.handler.ts` |
| Space RPC handlers | `packages/daemon/src/lib/rpc-handlers/space-*.ts` |
| Task banner precedence | `packages/web/src/lib/task-banner.ts` |
| Inline status banner (shared) | `packages/web/src/components/space/InlineStatusBanner.tsx` |
| Pending post-approval banner | `packages/web/src/components/space/PendingPostApprovalBanner.tsx` |
| Pending task completion banner | `packages/web/src/components/space/PendingTaskCompletionBanner.tsx` |
| Autonomy workflow summary (UI) | `packages/web/src/components/space/AutonomyWorkflowSummary.tsx` |
| Task blocked banner (UI) | `packages/web/src/components/space/TaskBlockedBanner.tsx` |
| Task status actions (UI) | `packages/web/src/components/space/TaskStatusActions.tsx` |
| Space tasks list (UI) | `packages/web/src/components/space/SpaceTasks.tsx` |
| Gate artifacts view (UI) | `packages/web/src/components/space/GateArtifactsView.tsx` |
| Space store | `packages/web/src/lib/space-store.ts` |
| Room runtime (comparison) | `packages/daemon/src/lib/room/runtime/room-runtime.ts` |
| Room lifecycle hooks (comparison) | `packages/daemon/src/lib/room/runtime/lifecycle-hooks.ts` |
| Room dead loop detector (comparison) | `packages/daemon/src/lib/room/runtime/dead-loop-detector.ts` |
| Room agent tools (comparison) | `packages/daemon/src/lib/room/tools/room-agent-tools.ts` |
| Global inbox (room-only) | `packages/web/src/components/inbox/Inbox.tsx` |
