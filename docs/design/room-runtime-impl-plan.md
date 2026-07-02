# Room Runtime Implementation Plan

> ⚠️ **Retired feature**: Room is no longer an active product surface. The Room Runtime is not started and no Room RPC APIs are registered. This document is preserved for historical reference only.
>
> Historical note (outdated state model):
> This implementation plan references older orchestration states (`awaiting_craft`, `awaiting_lead`, `hibernated`) and `escalated` task status, which are not current.
> For current behavior, use:
> - `docs/design/pr-review-workflow.md`
> - `docs/design/task-status-control-design.md`
> - `docs/design/room-runtime-spec.md`
> Current compatibility `session_groups.state` values are: `awaiting_worker | awaiting_leader | awaiting_human | completed | failed` (`hibernated` removed).

Status: Draft
Date: 2026-02-24
Related: [Room Runtime Spec v0.21](./room-runtime-spec.md)

## Goal: Reach Autonomous Room Operation

The minimal viable system that can **self-improve** needs:
1. Human can create goals/tasks via Room Agent
2. Runtime detects pending tasks and spawns (Craft, Lead) pairs
3. Craft does work, Lead reviews, feedback loop until accepted
4. Basic recovery from daemon restart

---

## Phase 0: Database Schema (Prerequisite)

**File:** `packages/daemon/src/storage/schema/migrations.ts`

### New Tables

```sql
-- Task pairs: tracks the (Craft, Lead) sessions for each task
CREATE TABLE task_pairs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    craft_session_id TEXT NOT NULL,
    lead_session_id TEXT NOT NULL,
    pair_state TEXT NOT NULL DEFAULT 'awaiting_craft',
        -- awaiting_craft | awaiting_lead | awaiting_human | hibernated | completed | failed
    feedback_iteration INTEGER NOT NULL DEFAULT 0,
    lead_contract_violations INTEGER NOT NULL DEFAULT 0,  -- Tracks retry count for tool call violations
    last_processed_lead_turn_id TEXT,  -- Idempotency marker for terminal state processing
    last_forwarded_message_id TEXT,
    active_work_started_at INTEGER,
    active_work_elapsed INTEGER NOT NULL DEFAULT 0,
    hibernated_at INTEGER,
    version INTEGER NOT NULL DEFAULT 0,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
);

-- Message queue: reliable inter-agent message delivery
CREATE TABLE task_messages (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    pair_id TEXT NOT NULL REFERENCES task_pairs(id),
    from_role TEXT NOT NULL,       -- 'craft' | 'lead' | 'human'
    to_role TEXT NOT NULL,         -- 'craft' | 'lead'
    to_session_id TEXT NOT NULL,   -- target session (prevents misdelivery on retry)
    message_type TEXT NOT NULL DEFAULT 'normal',  -- 'normal' | 'interrupt' | 'escalation_context'
    payload TEXT NOT NULL,         -- JSON message content
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | delivered | dead_letter
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
);
```

### Column Additions

```sql
-- Tasks table: add columns that don't exist yet
ALTER TABLE tasks ADD COLUMN task_type TEXT DEFAULT 'coding'
    CHECK (task_type IN ('planning', 'coding', 'research', 'design', 'goal_review'));
    -- 'planning' | 'coding' | 'research' | 'design' | 'goal_review'
ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN version INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN created_by_task_id TEXT;

-- Goals table
ALTER TABLE goals ADD COLUMN planning_attempts INTEGER DEFAULT 0;
ALTER TABLE goals ADD COLUMN goal_review_attempts INTEGER DEFAULT 0;

-- Rooms table
ALTER TABLE rooms ADD COLUMN config TEXT;
    -- JSON: { max_feedback_iterations, task_timeout, max_planning_attempts, ... }
```

---

## Phase 1: Core Infrastructure

### 1.1 TaskPairRepository

**File:** `packages/daemon/src/lib/room/task-pair-repository.ts`

CRUD operations for task_pairs table:

```typescript
class TaskPairRepository {
  createPair(taskId: string, craftSessionId: string, leadSessionId: string): TaskPair;
  getPair(pairId: string): TaskPair | null;
  getPairByTaskId(taskId: string): TaskPair | null;
  getActivePairs(roomId: string): TaskPair[];
  updatePairState(pairId: string, newState: PairState, version: number): TaskPair | null;
  incrementFeedbackIteration(pairId: string, version: number): TaskPair | null;
  completePair(pairId: string, version: number): TaskPair | null;
  failPair(pairId: string, version: number): TaskPair | null;
}
```

### 1.2 TaskMessageQueue

**File:** `packages/daemon/src/lib/room/task-message-queue.ts`

DB-backed message queue:

```typescript
class TaskMessageQueue {
  enqueue(params: {
    pairId: string;
    taskId: string;
    fromRole: 'craft' | 'lead' | 'human';
    toRole: 'craft' | 'lead';
    toSessionId: string;
    payload: string;
    messageType?: 'normal' | 'interrupt' | 'escalation_context';
  }): TaskMessage;

  dequeuePending(pairId: string, toRole: 'craft' | 'lead'): TaskMessage[];
  markDelivered(messageId: string): void;
  markDeadLetter(messageId: string): void;
  deadLetterAllForPair(pairId: string): void;
}
```

---

## Phase 2: Room Runtime Core

### 2.1 RoomRuntime Class

**File:** `packages/daemon/src/lib/room/room-runtime.ts`

```typescript
class RoomRuntime {
  private state: 'running' | 'paused' = 'running';
  private tickMutex = new Mutex(); // single-flight

  // Lifecycle
  start(): void;
  pause(): void;
  resume(): void;
  getState(): 'running' | 'paused';

  // Main scheduling loop
  tick(): Promise<void>;

  // Event handlers (trigger immediate tick)
  onGoalCreated(goalId: string): void;
  onTaskStatusChanged(taskId: string): void;
  onCraftTerminalState(pairId: string): void;
  onLeadTerminalState(pairId: string): void;  // Detects when Lead reaches terminal without calling a tool

  // Lead tool handling (called synchronously from MCP tool handlers)
  handleLeadTool(pairId: string, toolName: string, params: LeadToolParams): Promise<ToolResult>;
}
```

### Tick Trigger Matrix

| Event Source | Signal | Runtime Handler | Notes |
|--------------|--------|-----------------|-------|
| Room Agent MCP tools | `goal.created`, `task.created` | `onGoalCreated()`, `onTaskStatusChanged()` | After DB write succeeds |
| TaskManager | `task.status_changed` | `onTaskStatusChanged()` | After status update |
| SessionObserver | `session.terminal_state` (Craft) | `onCraftTerminalState()` | When Craft reaches result/error |
| SessionObserver | `session.terminal_state` (Lead) | `onLeadTerminalState()` | When Lead reaches terminal without tool call |
| `handleLeadTool()` | (internal) | Triggers tick after `complete_task`/`fail_task` | For task completion cleanup |
| Timer | 30s interval | `tick()` | Fallback for missed events |

**Idempotency:** All handlers are idempotent - duplicate events produce same result. Tick mutex prevents concurrent execution.

### Tick Logic

```
1. Check runtime state (paused → exit)
2. Acquire mutex (already locked → queue re-tick, exit)
3. For each room:
   a. Check capacity (maxConcurrentPairs)
   b. Find pending tasks → spawn (Craft, Lead) pair if below capacity
   c. Find awaiting_craft pairs with terminal Craft → collect messages, forward to Lead
   d. Check feedback_iteration >= max_feedback_iterations → auto-escalate
   e. Find awaiting_lead pairs with terminal Lead → trigger onLeadTerminalState
4. Log tick summary to room_audit_log
5. Release mutex
```

### 2.2 Session Observer

**File:** `packages/daemon/src/lib/room/session-observer.ts`

Detects terminal states from AgentSession:

```typescript
class SessionObserver {
  // Subscribe to session state changes
  observe(sessionId: string, onTerminal: (state: TerminalState) => void): void;

  // Stop observing
  unobserve(sessionId: string): void;

  // Cron safety net (60s): query DB for stuck sessions
  checkStuckSessions(): Promise<void>;
}
```

**Terminal state mapping:**
- `result/success` → Craft finished turn
- `result/error` → Craft errored
- `waiting_for_input` → AskUserQuestion

---

## Phase 3: Agent Sessions

### 3.1 Room Agent (Human Interface)

**File:** `packages/daemon/src/lib/room/room-agent.ts`

Persistent AgentSession for human conversation:
- Session ID: `room:chat:${roomId}` (already exists!)
- System prompt: "You are the Room Agent. Help humans manage goals and tasks..."

**MCP Tools:**

| Tool | Purpose |
|------|---------|
| `create_goal(title, description)` | Create a new goal |
| `list_goals()` | List all goals with status |
| `update_goal(goalId, updates)` | Update goal |
| `create_task(goalId, title, description)` | Create a task |
| `list_tasks(goalId?)` | List tasks |
| `update_task(taskId, updates)` | Update task |
| `cancel_task(taskId)` | Cancel a task |
| `get_room_status()` | Overview of room state |

**Key insight:** Room Agent session already exists (created in `room-handlers.ts`). We just need to add MCP tools.

### 3.2 Craft Agent (Worker)

**File:** `packages/daemon/src/lib/room/craft-agent.ts`

Standard AgentSession with coding tools:

```typescript
class CraftAgentFactory {
  create(task: Task, goal: Goal, room: Room): AgentSession;
}
```

**System prompt includes:**
- Task description and acceptance criteria
- Goal description (broader context)
- Room-level instructions/guidelines
- Previous task summaries for completed tasks in same goal

**Tools:** bash, edit, read, write, glob, grep (standard coding set)

**No special completion tools** - Craft just works until terminal state.

### 3.3 Lead Agent (Reviewer)

**File:** `packages/daemon/src/lib/room/lead-agent.ts`

AgentSession with review-specific tools:

```typescript
class LeadAgentFactory {
  create(task: Task, goal: Goal, room: Room): AgentSession;
}
```

**System prompt includes:**
- Goal description
- Task description and acceptance criteria
- Room-level review policy
- Activity-specific review instructions (coding, planning, etc.)
- Verification requirements

**MCP Tools (routed through Runtime):**

| Tool | Purpose |
|------|---------|
| `send_to_craft(message)` | Send feedback to Craft |
| `complete_task(summary)` | Accept work, mark done |
| `fail_task(reason)` | Task not achievable |

**Lead Tool Contract (CRITICAL):**

Lead Agent must call **exactly one terminal tool** per turn: `complete_task`, `fail_task`, `escalate`, or `send_to_craft`.

- If Lead emits text with no tool call, or calls multiple conflicting tools → Runtime retries once with system nudge: "You must call exactly one of: send_to_craft, complete_task, fail_task, or escalate"
- If second attempt also fails → Runtime auto-escalates to human

**Tool call validation:**
- Track per-pair state: `leadCalledToolMap: Map<pairId, boolean>` in RoomRuntime for fast-path detection
- Set `leadCalledToolMap.set(pairId, true)` when `handleLeadTool` is invoked
- SessionObserver monitors Lead sessions and triggers `onLeadTerminalState(pairId)` when Lead reaches terminal state
- In `onLeadTerminalState`:
  1. **Idempotency check:** Load pair from DB. Check `pair.last_processed_lead_turn_id` against current Lead session turn ID. If match, already processed → no-op
  2. Count Lead tool calls in current turn (check both in-memory map and session transcript):
     - If exactly 1 tool call → success, no-op
     - If 0 or multiple tool calls → contract violation, proceed to step 3
  3. **Retry-then-escalate logic:**
     - Load `pair.lead_contract_violations` counter from DB (defaults to 0)
     - If violations == 0 (first violation):
       - Inject system nudge into Lead session: "You must call exactly one of: send_to_craft, complete_task, fail_task, or escalate"
       - Increment `lead_contract_violations` to 1
       - Update `last_processed_lead_turn_id` to current turn ID
       - Keep `pair_state = 'awaiting_lead'`
     - If violations >= 1 (second violation):
       - Auto-escalate with reason: "Lead failed to call required tool after nudge"
       - Update `pair_state = 'awaiting_human'`
       - Update `last_processed_lead_turn_id` to current turn ID
  4. Reset `lead_contract_violations` to 0 when forwarding new Craft output to Lead

**Crash safety:** After restart, `leadCalledToolMap` is empty, so transcript check acts as durable fallback. Per-turn marker prevents duplicate processing across recovery.

**Idempotency:** Turn-based marker (`last_processed_lead_turn_id`) prevents duplicate nudges/escalations from SessionObserver, tick scan, and recovery paths, even when retry maintains `awaiting_lead` state.

**Lead Tool Routing (MCP Callback Pattern):**

Lead MCP tools are defined with callback functions that call into Runtime methods directly (same pattern as `lobby-agent-tools.ts`):

```typescript
// In lead-agent-tools.ts
tool('send_to_craft', 'Send feedback to Craft', { message: z.string() }, async (params) => {
  return runtime.handleLeadTool(pairId, 'send_to_craft', params);
});

// In RoomRuntime
handleLeadTool(pairId: string, toolName: string, params: LeadToolParams): Promise<ToolResult> {
  // 1. Validate pair_state == 'awaiting_lead'
  // 2. Validate task version matches expected
  // 3. Execute the action (MVP: no interrupt validation - queue not used)
  // 4. Return tool result to Lead
}
```

This is **synchronous** — the tool handler calls Runtime directly, Runtime validates and executes, then returns the result. No DaemonHub events involved.

---

## Phase 4: Task Pair Manager

**File:** `packages/daemon/src/lib/room/task-pair-manager.ts`

Creates and manages (Craft, Lead) pairs:

```typescript
class TaskPairManager {
  // Spawn a new pair for a task
  async spawnPair(task: Task, goal: Goal, room: Room): Promise<TaskPair>;

  // Route Craft terminal state to Lead
  async routeCraftToLead(pairId: string, terminalState: TerminalState): Promise<void>;

  // Route Lead feedback to Craft
  async routeLeadToCraft(pairId: string, message: string): Promise<void>;

  // Handle pair completion
  async completePair(pairId: string, summary: string): Promise<void>;

  // Handle pair failure
  async failPair(pairId: string, reason: string): Promise<void>;

  // Cancel pair (urgent control)
  async cancelPair(pairId: string): Promise<void>;
}
```

### Pair Creation Flow

1. Create Craft session with task context
2. Create Lead session with review context
3. Create task_pairs record (state: `awaiting_craft`)
4. Set task status to `in_progress`
5. Start observing Craft session

---

## Phase 5: Message Routing

### 5.1 Craft → Lead Routing

When Craft reaches terminal state:

1. Runtime detects via session observer
2. Collect all assistant messages since last user message
3. Format as structured envelope:
   ```
   [CRAFT OUTPUT] Iteration: {n}
   Task: {task_title}
   Task type: {task_type}
   Terminal state: {success|error|question}
   Tool calls: ["Edit src/auth.ts (+42 lines)", ...]
   ---
   {craft_assistant_messages}
   ```
4. Send to Lead session as user message
5. Update pair state to `awaiting_lead`

### 5.2 Lead → Craft Routing

When Lead calls `send_to_craft(feedback)`:

1. Runtime intercepts tool call
2. Enqueue message in task_messages
3. Inject message into Craft session as user message
4. Update pair state to `awaiting_craft`
5. Increment feedback_iteration

**Note:** For MVP, Lead→Craft is synchronous (direct injection). The `task_messages` queue is **not used** — messages are not persisted or recovered.

### 5.3 Escalation Return Path

When Lead calls `escalate(reason)`:

1. Runtime sets pair state to `awaiting_human`
2. Runtime sets task status to `escalated`
3. Runtime notifies human (via Room Agent message + UI event)
4. **Human responds directly to Lead session** — sends message via UI
5. Runtime detects human message to Lead session → transitions pair back to `awaiting_lead`
6. Lead re-evaluates with human guidance and calls a terminal tool

**Detection mechanism:** Runtime listens for DaemonHub `message.sent` events filtered to Lead sessions with pairs in `awaiting_human` state. When a human message arrives, transition the pair.

**Why this works:** Lead session is a standard AgentSession. Human messages to Lead are just user messages in that session.

### 5.4 Task Selection Ordering

When multiple pending tasks exist, Runtime selects by:
1. `priority` TEXT sort: `urgent` > `high` > `normal` > `low` (mapped in code)
2. `created_at` ASC (oldest first)
3. `id` ASC (deterministic tiebreaker)

---

## Phase 6: Recovery

**File:** `packages/daemon/src/lib/room/runtime-recovery.ts`

On daemon startup:

```typescript
async function recoverRuntime(db: Database, runtime: RoomRuntime): Promise<void> {
  // 1. Find all in_progress tasks with active pairs
  const activePairs = db.query(`
    SELECT tp.* FROM task_pairs tp
    JOIN tasks t ON tp.task_id = t.id
    WHERE t.status = 'in_progress'
    AND tp.pair_state NOT IN ('completed', 'failed')
  `);

  // 2. For each pair, re-attach observers
  for (const pair of activePairs) {
    switch (pair.pair_state) {
      case 'awaiting_craft':
        // Check if Craft session still exists
        if (!sessionExists(pair.craft_session_id)) {
          // Session lost - mark task and pair failed
          await failTask(pair.task_id, 'session_lost');
          await failPair(pair.id, 'session_lost');
          await logAudit(pair.room_id, 'session_lost', { pairId: pair.id });
        } else {
          // Check if already in terminal state (completed before crash)
          const sessionState = getSessionState(pair.craft_session_id);
          if (isTerminalState(sessionState)) {
            // Already terminal - process immediately
            await runtime.onCraftTerminalState(pair.id);
          } else {
            // Still active - observe for future terminal state
            sessionObserver.observe(pair.craft_session_id, onTerminal);
          }
        }
        break;
      case 'awaiting_lead':
        // Check if Lead session still exists
        if (!sessionExists(pair.lead_session_id)) {
          // Session lost - mark task and pair failed
          await failTask(pair.task_id, 'session_lost');
          await failPair(pair.id, 'session_lost');
          await logAudit(pair.room_id, 'session_lost', { pairId: pair.id });
        } else {
          // Check if already in terminal state (completed before crash)
          const sessionState = getSessionState(pair.lead_session_id);
          if (isTerminalState(sessionState)) {
            // Already terminal - process immediately
            await runtime.onLeadTerminalState(pair.id);
          } else {
            // Still active - observe for future terminal state
            sessionObserver.observe(pair.lead_session_id, onTerminal);
          }
        }
        break;
      case 'awaiting_human':
      case 'hibernated':
        // No action needed - waiting for human
        break;
    }
  }

  // 4. MVP: No queue recovery needed (direct synchronous routing)
  // When human queueing is implemented, reprocess pending messages here

  // 5. Resume tick loop
  runtime.start();
}
```

**Key Recovery Insight:**

Recovery must be **proactive**, not purely event-driven. The logic checks if sessions are already in terminal state *before* subscribing to future terminal events. Without this check, pairs with sessions that completed right before the crash would wait 60 seconds for the cron safety net, delaying recovery unnecessarily.

The human-inspired pattern: check current state first, then subscribe only if still active.

**MVP Recovery Behavior:**
- In-flight Lead→Craft messages are lost on crash (acceptable - Lead can resend after recovery)
- Human messages to escalated pairs are lost (will be fixed with queue implementation)
- **Dangling tool calls:** If Lead session has incomplete tool calls after crash (tool invoked but result not returned), recovery treats this as session corruption → fail pair with reason "session_lost" and notify human. This prevents indefinite wedging while maintaining deterministic recovery.

---

## Implementation Order

```
Phase 0: Database Schema          [Prerequisite]
    ↓
Phase 1.1: TaskPairRepository               [Needs schema]
Phase 1.2: TaskMessageQueue                 [Needs schema - stub only for MVP]
    ↓
Phase 1.2: TaskMessageQueue
    ↓
Phase 3.1: Room Agent Tools       ← Human can create tasks
    ↓
Phase 3.2: Craft Agent
    ↓
Phase 3.3: Lead Agent
    ↓
Phase 4: TaskPairManager
    ↓
Phase 2.1: RoomRuntime Tick       ← Autonomous operation!
    ↓
Phase 2.2: Session Observer
    ↓
Phase 5: Message Routing
    ↓
Phase 6: Recovery
```

**Critical path to first integration test:** Phases 0 → 1.1 → 3 → 2.2 → 4 → 5 → 2.1

**Note:** Phase 1.2 (TaskMessageQueue) can be implemented as a minimal stub with empty methods for MVP, since messages are not persisted.

---

## Minimal Viable Feature Set

### Included (MVP)

- ✅ Human creates goals/tasks via Room Agent
- ✅ Runtime detects pending tasks
- ✅ Runtime spawns (Craft, Lead) pairs
- ✅ Craft works, Lead reviews
- ✅ Feedback loop until accepted
- ✅ Basic daemon restart recovery

### Deferred (room can build these later)

- ⏳ Planning as (Craft, Lead) pair (human creates tasks manually)
- ⏳ Goal review (human marks complete)
- ⏳ Escalation flow (Lead can fail_task)
- ⏳ Human message queueing during Lead review
- ⏳ Interrupt handling
- ⏳ Task timeout
- ⏳ Goal completion detection
- ⏳ Parallel pairs (maxConcurrentPairs > 1)
- ⏳ Escalation SLA / hibernation
- ⏳ `run_verification` tool for Lead
- ⏳ `read_craft_messages` tool for Lead

---

## Unit Test Plan

Each component needs tests before integration:

| Component | Test File | Key Test Cases |
|-----------|-----------|----------------|
| TaskPairRepository | `task-pair-repository.test.ts` | CRUD, optimistic locking, version conflicts |
| TaskMessageQueue | `task-message-queue.test.ts` | Schema only (stub implementation for MVP) |
| RoomRuntime | `room-runtime.test.ts` | Tick logic, mutex, capacity checks, Lead terminal detection |
| SessionObserver | `session-observer.test.ts` | Terminal state detection (Craft & Lead), stuck session recovery |
| TaskPairManager | `task-pair-manager.test.ts` | Pair creation, routing, completion |

---

## First Test Scenario

1. Start daemon, open HyperNeo UI
2. Navigate to a room
3. Send message to Room Agent: "Create a goal to add a health check endpoint"
4. Room Agent creates goal via tool
5. Send message: "Create a task for the health check goal"
6. Room Agent creates task
7. Runtime tick detects pending task → spawns (Craft, Lead)
8. Watch Craft work in UI
9. Watch Lead review in UI
10. Loop until Lead calls `complete_task`

**This is the minimal autonomous loop.** Once this works, the room can help implement the deferred features.

---

## File Structure

```
packages/daemon/src/lib/room/
├── room-manager.ts          # Existing
├── goal-manager.ts          # Existing
├── task-manager.ts          # Existing
├── task-pair-repository.ts  # NEW
├── task-message-queue.ts    # NEW
├── room-runtime.ts          # NEW
├── session-observer.ts      # NEW
├── task-pair-manager.ts     # NEW
├── runtime-recovery.ts      # NEW
├── room-agent.ts            # NEW
├── craft-agent.ts           # NEW
└── lead-agent.ts            # NEW
```
