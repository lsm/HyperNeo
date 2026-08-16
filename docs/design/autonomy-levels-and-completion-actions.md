# Design: Autonomy Levels & Completion Actions

Date: 2026-04-14
Status: **Superseded** (2026-04-24) — the autonomy-levels half of this doc shipped, but the `completionActions` half was replaced by workflow-declared `postApproval` routing. See [`docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md`](../plans/remove-completion-actions-task-agent-as-post-approval-executor.md) for the replacement design and the five PRs that delivered it (#1620, #1621, #1623, #1628, plus the schema/docs cleanup PR 5/5). The `CompletionAction` interface, `pendingActionIndex` field, and `pending_checkpoint_type='completion_action'` value referenced below no longer exist in the codebase as of PR 5/5; treat §"Completion actions" of this document as historical context only.

## Problem

The space system has a binary autonomy model (`supervised` / `semi_autonomous`) with exactly two enforcement points (`space-runtime.ts:507,1202`). Both do the same thing: route task completion to `review` or `done`. During execution, both modes behave identically. There is no mechanism to:

1. Execute post-approval actions (merge PRs, deploy, notify external systems)
2. Auto-approve gates based on risk tolerance
3. Pause execution at specific high-risk checkpoints while allowing low-risk steps to proceed automatically
4. Give humans a single place to approve/skip multiple pending checkpoints

## Design

### 1. Numeric Autonomy Levels (1–5)

Replace the binary `supervised` / `semi_autonomous` with a 5-level numeric scale. Levels have no prescribed names — workflow authors assign meaning per their domain.

```typescript
type AutonomyLevel = 1 | 2 | 3 | 4 | 5;
```

The level is set on the **space** and represents the operator's risk tolerance. Every checkpoint (gate or completion action) declares its `requiredLevel`. The comparison is simple:

```
space.autonomyLevel >= checkpoint.requiredLevel → auto-approved
space.autonomyLevel <  checkpoint.requiredLevel → pause for human
```

Example level assignments (non-prescriptive):

| Level | Example usage |
|-------|---------------|
| 1 | Agent works, all outputs need human approval |
| 2 | Routine work auto-approved (linting, formatting, test runs) |
| 3 | Code changes and staging deployments auto-approved |
| 4 | PR merges, release tagging auto-approved |
| 5 | Production deployments auto-approved |

### 2. Checkpoints

A **checkpoint** is any point where execution may pause for human approval. There are two kinds:

#### 2a. Gates (workflow-level)

Gates guard channel transitions in workflows. This design separates **validation** (is this objectively ready?) from **approval** (does a human allow proceeding?).

```typescript
interface WorkflowGate {
  id: string;
  channelId: string;

  // --- Validation (always runs, autonomy never overrides) ---
  writers: string[];              // node IDs that can write gate data (access control)
  fields?: GateFieldCheck[];      // data conditions (e.g., "3 approvals", "CI passed")
  script?: string;                // validation script (e.g., "is PR mergeable?")

  // --- Approval (autonomy can override) ---
  requiredLevel?: AutonomyLevel;  // default: undefined (no approval needed beyond validation)
}
```

**Validation vs Approval — the two layers:**

| Layer | Purpose | Overridden by autonomy? |
|-------|---------|------------------------|
| **Validation** (`script` + `fields`) | Checks objective facts: "Is CI green? Are there 3 reviewer approvals? Is the PR mergeable?" | **Never.** Always runs. A failing script blocks the gate at any autonomy level. |
| **Approval** (`requiredLevel`) | Human sign-off: "I'm OK with this proceeding." | **Yes.** If `space.autonomyLevel >= gate.requiredLevel`, approval is granted automatically. |

**Gate evaluation flow:**

```
Gate encountered →
  Step 1: VALIDATION
    Run script (if defined) → fail? BLOCKED. Stop.
    Check field conditions → fail? BLOCKED. Stop.
    
  Step 2: APPROVAL
    requiredLevel not set? → no approval needed → OPEN
    space.autonomyLevel >= gate.requiredLevel?
      → auto-approve: write { approved: true, source: 'auto_policy' } → OPEN
    space.autonomyLevel < gate.requiredLevel?
      → PAUSE for human → surface in approval UI
```

**Key invariant:** Autonomy level never bypasses validation. A gate with a script that checks "is CI green?" will block even at level 5 if CI is red. Autonomy only replaces the human sign-off step.

**Example — PR merge gate:**
```typescript
{
  id: 'pr-merge-gate',
  channelId: 'code-to-review',
  writers: ['coder'],
  script: 'gh pr view ... --json mergeable | check CI + reviews',  // validation
  requiredLevel: 4,                                                 // approval
}
```
- CI red → blocked (validation failed, autonomy irrelevant)
- CI green, space at level 2 → pauses for human approval
- CI green, space at level 4 → auto-approved, workflow continues

**Migration from `writers: ['human']`:**
- Remove `'human'` as a valid `writers` value
- Replace with `requiredLevel` on the gate (e.g., `requiredLevel: 5` for "always needs human unless fully autonomous")
- `writers` becomes purely structural access control: which node IDs can write data to this gate

#### 2b. Completion Actions (node-level)

Completion actions run after a task is approved (or auto-approved). They are defined on workflow nodes and execute in definition order.

```typescript
interface CompletionAction {
  id: string;
  name: string;
  type: 'script' | 'instruction' | 'mcp_call';
  requiredLevel: AutonomyLevel;
  artifactType?: ArtifactType;    // which artifact to resolve as context
  artifactKey?: string;           // specific key, or all of that type
}

interface ScriptCompletionAction extends CompletionAction {
  type: 'script';
  script: string;                 // artifact data injected as env vars
}

interface InstructionCompletionAction extends CompletionAction {
  type: 'instruction';
  agentName: string;              // name of the SpaceAgent that will execute the instruction
  instruction: string;            // supports {{artifact.field}} templates
  timeoutMs?: number;             // default 120000 — max time to wait for the verifier agent
}

interface McpCallCompletionAction extends CompletionAction {
  type: 'mcp_call';
  server: string;                 // MCP server name (must be enabled in space skills)
  tool: string;                   // tool name on that server
  args: Record<string, string>;   // supports {{artifact.field}} templates
  expect?: McpCallExpectation;    // optional assertion applied to the tool result
}

interface McpCallExpectation {
  path: string;                   // dot/bracket accessor into the result (e.g. 'data.items[0].status')
  op: 'eq' | 'neq' | 'contains' | 'exists' | 'truthy';
  value?: unknown;                // required for eq/neq/contains, ignored for exists/truthy
}
```

**`instruction` executor.** The runtime resolves `agentName` to a SpaceAgent, spawns an ephemeral verification session bound to that agent, injects a `report_verification(pass, reason)` MCP tool, and sends `instruction` (template-interpolated from the resolved artifact) as the user message. The action completes when the agent calls `report_verification` — passing `true` makes the action succeed, `false` makes it fail with the supplied `reason`. If the agent does not call the tool within `timeoutMs` (default 120s), the action fails with reason `'timed out'`.

**`mcp_call` executor.** The runtime invokes `tool` on `server` with `args`. If `expect` is provided, the `path`/`op`/`value` assertion is applied to the tool's JSON result; a failing assertion fails the action with a descriptive reason (e.g. `'expected "state" to equal "MERGED", got "OPEN"'`). Any thrown error from the tool invocation fails the action with the error's message.

Both executors are **dependency-injected** into `SpaceRuntime` via `SpaceRuntimeConfig.instructionActionExecutor` and `SpaceRuntimeConfig.mcpToolExecutor`. When an executor is not configured, the corresponding action type fails with a configuration error rather than silently succeeding — the runtime refuses to skip a human-authored verification step.

Three action types cover the spectrum of complexity:

| Type | Use case | Deterministic? | Needs agent? |
|------|----------|---------------|-------------|
| `script` | CLI commands (`gh pr merge`, `npm publish`) | Yes | No |
| `mcp_call` | External service calls (Slack, JIRA, deploy tools) | Yes | No |
| `instruction` | Complex reasoning tasks (write release notes, analyze test results) | No | Yes |

### 2c. `report_result`: agents report outcomes, runtime decides status

Agents signal task completion by calling the `report_result` MCP tool. Stage-2 tightens this tool's contract so that agents can no longer self-certify terminal status:

```typescript
report_result({
  summary: string,                 // human-readable summary of what was done
  evidence?: {                     // optional structured evidence
    prUrl?: string,
    commitSha?: string,
    testOutput?: string,
    // ...additional keys allowed via passthrough
  },
})
```

The Zod schema is `.strict()` — passing a `status` or `error` field is a **validation error**, not silently accepted. This is enforced at both the Task Agent and Node Agent `report_result` surfaces (`task-agent-tool-schemas.ts`, `node-agent-tools.ts`).

**The completion-action pipeline is the sole arbiter of terminal task status.** When a `report_result` call is recorded:

1. The runtime sets `task.reportedStatus = 'done'` and stores the agent's summary (+ serialized evidence block) on `task.reportedSummary`.
2. `CompletionDetector` fires on the `reportedStatus` change and triggers `resolveCompletionWithActions()`.
3. The completion actions on the end node run in order. Their collective outcome decides whether the task ends `done` (all actions passed), pauses at `review` (an action requires human approval), or ends `blocked` (an action failed).

Notably, **the runtime does NOT read `reportedStatus` to decide terminal status anymore** — it only uses it as a trigger. Legacy values like `reportedStatus='blocked'` or `'cancelled'` written by older code paths do NOT short-circuit the pipeline. This closes the "agent lies" gap: an agent claiming "I merged the PR" cannot mark the task `done` — the `VERIFY_PR_MERGED` completion action on the workflow's QA end node runs regardless and will fail the task if the PR is still open.

### 3. Execution Flow

#### Gate evaluation (during workflow execution)

See Section 2a above for the full validation → approval flow.

**Implementation detail:** Auto-approval writes gate data just like a human or agent would, through `gateDataRepo.merge()`. This means:
- The gate evaluator itself doesn't change — it still checks data against conditions
- Audit trail is automatic (approval data is persisted like any other gate write)
- `onGateDataChanged` fires naturally, activating downstream nodes through the existing path

#### Completion actions (after task/node completes)

```
Task completes →
  load node's completionActions[]
  for each action in definition order:
    if space.autonomyLevel >= action.requiredLevel:
      execute action immediately
    else:
      pause task at this action
      set task.status = 'review'
      set task.pendingActionIndex = current index
      wait for human approval
      on approval: execute, continue to next action
      on skip: record skip, continue to next action
  all actions done → task status = 'done'
```

#### User-defined end nodes as an alternative

With autonomy-leveled gates, users can express post-approval workflows as nodes instead of completion actions:

```
[Coder] →gate(L2)→ [Reviewer] →gate(L4)→ [Release] →gate(L5)→ [Deploy]
```

Each gate auto-approves or pauses based on the space's level. This is the preferred pattern for complex multi-step post-completion work that requires agent reasoning. Completion actions are ergonomic shorthand for lightweight scripts and calls that don't need a full agent node.

### 4. Approval Model

#### Approval source

Replace the current `SpaceApprovalSource` union:

```typescript
// Current (remove)
type SpaceApprovalSource =
  | 'human' | 'neo_agent' | 'space_agent' | 'task_agent' | 'node_agent' | 'semi_auto';

// New
type ApprovalSource = 'human' | 'auto_policy' | 'agent';
```

- `human` — user clicked approve in the UI
- `auto_policy` — space autonomy level >= required level (replaces `semi_auto`)
- `agent` — agent used approve_gate/approve_task tool, or the node-agent `complete_validation_task` validation-only close (collapses all agent sub-types; specific agent identity is tracked in session metadata)

#### Approval record

Every approval (gate or completion action) records:

```typescript
interface ApprovalRecord {
  source: ApprovalSource;
  requiredLevel: AutonomyLevel;   // the level the checkpoint required
  spaceLevel: AutonomyLevel;      // the space's level at decision time
  timestamp: number;
  reason?: string;                // human-provided or agent-provided reason
  skipped?: boolean;              // true if human chose to skip this action
}
```

### 5. Task Status During Completion Actions

No new task status needed. Use `review` with metadata:

```typescript
// New fields on SpaceTask
pendingActionIndex: number | null;     // index of the completion action awaiting approval
pendingCheckpointType: 'completion_action' | 'gate' | null;
```

When `status === 'review' && pendingActionIndex !== null`: task work is complete, paused at a specific completion action.
When `status === 'review' && pendingActionIndex === null`: classic "task output needs human review."

### 6. Approval UI — Batch Modal

When a human reviews a task, a modal shows all pending checkpoints:

```
Task: "Release v2.3.1"
Status: Awaiting approval (action 3 of 5)

  [done]  Run integration tests       (level 1)
  [done]  Build release artifacts      (level 1)
  [ ]     Push to staging              (level 3)    [Approve] [Skip]
  [ ]     Tag & create release         (level 4)    [Approve] [Skip]
  [ ]     Deploy to production         (level 5)    [Approve] [Skip]

                          [Approve Selected]  [Cancel]
```

- Already-executed actions shown as completed (not editable)
- All pending actions shown together for batch sign-off
- Each can be individually approved or skipped
- Single submit executes all approved actions in order, records skips
- Pending gates for the task's workflow run appear in the same modal

### 7. Migration from Binary Model

| Current | New |
|---------|-----|
| `autonomyLevel: 'supervised'` | `autonomyLevel: 1` |
| `autonomyLevel: 'semi_autonomous'` | `autonomyLevel: 3` (or operator's choice) |
| `writers: ['human']` on gates | `requiredLevel: 5` on gate |
| `approvalSource: 'semi_auto'` | `source: 'auto_policy'` |
| `approvalSource: 'space_agent'` etc. | `source: 'agent'` |

DB migration adds `required_level INTEGER` to gate definitions and `pending_action_index INTEGER` / `pending_checkpoint_type TEXT` to `space_tasks`. The `autonomy_level` column on `spaces` changes from TEXT to INTEGER.

## Key Files to Modify

| File | Change |
|------|--------|
| `packages/shared/src/types/space.ts` | `AutonomyLevel` type, `CompletionAction` types, `ApprovalSource`, `ApprovalRecord`, updated `SpaceTask` fields |
| `packages/daemon/src/lib/space/runtime/space-runtime.ts` | Replace binary check at :507 and :1202 with level comparison + completion action pipeline |
| `packages/daemon/src/lib/space/runtime/gate-evaluator.ts` | Keep existing validation logic unchanged; no autonomy awareness here |
| `packages/daemon/src/lib/space/runtime/channel-router.ts` | After gate validation passes, check `requiredLevel` vs space level for auto-approval |
| `packages/daemon/src/lib/space/managers/space-task-manager.ts` | Track `pendingActionIndex`, handle approve/skip transitions |
| `packages/daemon/src/lib/space/tools/space-agent-tools.ts` | Update `approve_task` / `approve_gate` to use new approval model |
| `packages/daemon/src/lib/space/tools/task-agent-tools.ts` | Update `approve_gate` tool |
| `packages/daemon/src/lib/space/workflows/built-in-workflows.ts` | Add completion actions to built-in workflow nodes, add `requiredLevel` to gates |
| `packages/daemon/src/storage/schema/migrations.ts` | New migration for schema changes |
| `packages/web/src/components/space/TaskBlockedBanner.tsx` | Approval modal with batch checkpoint sign-off |

## Non-Goals (v1)

- Completion action retry/rollback UI (record failures, but manual re-run)
- Per-action conditional logic (if action 2 fails, skip action 3) — keep it simple: sequential, fail-and-continue
- Dynamic autonomy level changes mid-pipeline (level is read at each checkpoint, so changing the space level takes effect at the next unevaluated checkpoint)
- Webhooks for approval requests (use MCP call actions + external notification nodes instead)
