# ADR 0001: Live Query and Job Queue Architecture

## Status

Proposed

## Context

### Current State Synchronization Approach

HyperNeo currently uses a manual broadcasting pattern for state synchronization:

1. **StateManager** maintains in-memory caches of session state
2. **DaemonHub (EventBus)** emits events like `session.created`, `session.updated`, `sdk_messages.saved`
3. **StateManager** listens to these events, updates caches, and broadcasts to clients via MessageHub
4. Data is persisted to SQLite, but state changes flow through a separate event path

This creates a **dual-path synchronization problem**:
- Database writes happen via repositories (e.g., `SessionRepository`, `SDKMessageRepository`)
- State broadcasts happen via EventBus events
- These two paths can diverge, leading to stale or missing state on clients

### Existing Infrastructure

The codebase already has reactive database infrastructure implemented:

**ReactiveDatabase** (`packages/daemon/src/storage/reactive-database.ts`):
- Wraps the Database facade with a Proxy
- Emits `change` events when write operations modify tables
- Tracks table versions for optimistic concurrency
- Supports batch transactions with deduplicated change events

**LiveQueryEngine** (`packages/daemon/src/storage/live-query.ts`):
- Registers SQL queries with parameters and callbacks
- Subscribes to ReactiveDatabase change events
- Re-evaluates queries when dependent tables change
- Computes row-level diffs (added/removed/updated)
- Delivers snapshot (initial) and delta (subsequent) callbacks

**JobQueueRepository and JobQueueProcessor** (`packages/daemon/src/storage/`):
- Persistent job queue backed by `job_queue` table
- Supports priority, retries, delayed execution, stale job recovery
- Polling-based processor (not yet wired into app lifecycle)

### Problem Statement

1. **Dual Sources of Truth**: StateManager caches and database can diverge
2. **Manual Broadcast Maintenance**: Every write operation requires corresponding event emission
3. **Complex State Manager**: 670+ lines of event wiring and cache management
4. **Race Conditions**: Events can arrive out of order or be missed during reconnection
5. **No Unified Subscription Model**: Clients must know which channels to subscribe to

## Decision

### Core Principle

**The database is the message bus. Live Query is the subscription mechanism. No manual broadcasting for DB-backed state.**

Any data persisted to SQLite MUST be delivered to clients through LiveQueryEngine, not through manual event broadcasting.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Write Path                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Agent/Handler         Repository          ReactiveDatabase        │
│        │                    │                     │                 │
│        │  saveSDKMessage()  │                     │                 │
│        └───────────────────>│                     │                 │
│                           │  INSERT INTO         │                 │
│                           └────────────────────>│                  │
│                                                │ change:sdk_messages│
│                                                └──────────┐         │
│                                                           │         │
└───────────────────────────────────────────────────────────┼─────────┘
                                                            │
                                                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      LiveQueryEngine                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Table Change ──> Re-evaluate ──> Compute Diff ──> Callback        │
│      Event          Affected          (added/         │              │
│                      Queries          removed/         │              │
│                                       updated)         │              │
│                                                        │              │
└────────────────────────────────────────────────────────┼─────────────┘
                                                         │
                                                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      MessageHub Bridge                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   QueryDiff ──> Channel Broadcast ──> WebSocket ──> Client          │
│   {type,        state.sessions      │               │               │
│    rows,        state.messages      │               │               │
│    added,                          │               │                │
│    ...}                            │               │                │
│                                    │               │                │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Classification

**Tables that MUST use Live Query (DB-backed state):**

| Table | Live Query | Current Path |
|-------|------------|--------------|
| `sessions` | `SELECT * FROM sessions WHERE ...` | EventBus -> StateManager |
| `sdk_messages` | `SELECT * FROM sdk_messages WHERE session_id = ?` | EventBus -> StateManager |
| `job_queue` | `SELECT * FROM job_queue WHERE queue = ? AND status = ?` | Not wired |
| `rooms` | `SELECT * FROM rooms WHERE ...` | Direct DB reads |
| `tasks` | `SELECT * FROM tasks WHERE room_id = ?` | Direct DB reads |
| `goals` | `SELECT * FROM goals WHERE task_id = ?` | Direct DB reads |
| `inbox_items` | `SELECT * FROM inbox_items WHERE ...` | Direct DB reads |
| `room_github_mappings` | `SELECT * FROM room_github_mappings WHERE room_id = ?` | Direct DB reads |

**Things that remain as EventBus/Signals (NOT in DB):**

| Category | Examples | Why Not in DB |
|----------|----------|---------------|
| Agent Commands | interrupt, reset, model switch | Transient, no persistence needed |
| Connection State | WebSocket status, API connectivity | Ephemeral session state |
| UI Navigation | Active tab, selected session | Client-local state |
| Processing State | streaming, idle | In-memory only (until persisted) |

### State Channels (Revised)

```
state.sessions       <- LiveQuery: SELECT * FROM sessions WHERE status != 'archived'
state.messages       <- LiveQuery: SELECT * FROM sdk_messages WHERE session_id = ?
state.jobs           <- LiveQuery: SELECT * FROM job_queue WHERE queue = ?
state.system         <- EventBus: auth + config + health (non-DB state)
state.connection     <- EventBus: WebSocket + API status (transient)
```

### Job Queue Integration

JobQueueProcessor provides background task execution:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Enqueue Job    │     │ JobQueueProcessor│     │ ReactiveDatabase│
│  (any handler)  │────>│  (polling loop)  │────>│  (change event) │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                              │                        │
                              │ process()              │ change:job_queue
                              ▼                        ▼
                        ┌─────────────────┐     ┌─────────────────┐
                        │ JobQueueRepository    │ LiveQueryEngine │
                        │ (status update) │     │ (notify subs)   │
                        └─────────────────┘     └─────────────────┘
```

Use cases:
- Background GitHub API polling
- Deferred notification delivery
- Scheduled cleanup tasks
- Retry-able external API calls

## Consequences

### Positive

1. **Single Source of Truth**: Database is the authoritative state; no cache drift
2. **Automatic Change Propagation**: Write to DB -> client notified automatically
3. **Simpler Mental Model**: One path for all DB-backed state
4. **Reduced Code**: Remove ~400 lines of manual broadcast code from StateManager
5. **Built-in Reconnection Handling**: Client re-subscribes; LiveQuery sends current snapshot
6. **Efficient Deltas**: Only changed rows transmitted
7. **Testable**: LiveQuery is a pure function of DB state

### Negative

1. **Migration Effort**: Existing state channels need gradual migration
2. **Query Complexity**: Some queries need careful indexing for performance
3. **Learning Curve**: Team needs to understand reactive patterns
4. **Initial Duplication**: During migration, both paths may coexist temporarily

### Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Query performance degradation | Add indexes; use query explain; cache query plans |
| Excessive re-evaluation on batch writes | ReactiveDatabase.beginTransaction/commitTransaction |
| Memory usage from cached query results | Limit subscriptions; dispose unused handles |
| Breaking existing clients during migration | Phase migration; maintain backward compatibility |

## Implementation Phases

### Phase 0: Foundation (Complete)

- [x] ReactiveDatabase with proxy-based change detection
- [x] LiveQueryEngine with diff computation
- [x] JobQueueRepository with enqueue/dequeue/complete/fail
- [x] JobQueueProcessor with polling execution
- [ ] Wire JobQueueProcessor into app lifecycle (DaemonApp)

### Phase 1: Live Query RPC

- [ ] Add `liveQuery.subscribe` RPC method
- [ ] Create subscription handle management per WebSocket connection
- [ ] Auto-cleanup subscriptions on WebSocket disconnect
- [ ] Expose table version for optimistic client caching

```typescript
// RPC: liveQuery.subscribe
{
  sql: "SELECT * FROM sdk_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 100",
  params: ["session-123"],
  channel: "state.messages"  // Broadcast channel for diffs
}

// Response: Initial snapshot
{
  type: "snapshot",
  rows: [...],
  version: 42
}

// Subsequent broadcasts on channel "state.messages":
{
  type: "delta",
  rows: [...],
  added: [...],
  removed: [],
  updated: [...],
  version: 43
}
```

### Phase 2: Migrate Sessions List

- [ ] Create `state.sessions` live query subscription
- [ ] Update frontend to subscribe via `liveQuery.subscribe`
- [ ] Remove `broadcastSessionsDelta` from StateManager
- [ ] Keep `state.system` on EventBus (auth, config non-DB state)

### Phase 3: Migrate SDK Messages

- [ ] Create `state.messages` live query subscription
- [ ] Update frontend to use live query for message history
- [ ] Remove `broadcastSDKMessagesDelta` from StateManager
- [ ] Handle large message lists with pagination queries

### Phase 4: Cleanup

- [ ] Remove manual broadcasting methods from StateManager
- [ ] Remove event listeners for DB-backed state changes
- [ ] Simplify StateManager to handle only non-DB state
- [ ] Update documentation and examples

### Phase 5: Job Queue Integration

- [ ] Wire JobQueueProcessor into DaemonApp lifecycle
- [ ] Register handlers for background tasks (GitHub polling, etc.)
- [ ] Add `state.jobs` live query for job status monitoring
- [ ] Implement job retry and cleanup policies

## Alternatives Considered

### 1. Keep Manual Broadcasting

**Rejected**: Dual-path synchronization is a recurring source of bugs. Every write must be paired with a broadcast, easy to forget.

### 2. Use External Message Broker (Redis Pub/Sub)

**Rejected**: Adds deployment complexity. SQLite is already the source of truth; no need for another moving part.

### 3. WebSocket-only State (No DB)

**Rejected**: Loses persistence. Session history and message recovery after restart would be impossible.

### 4. Polling-based Client Refresh

**Rejected**: Inefficient. Creates unnecessary load and latency. Live query provides push-based updates.

## References

- [ReactiveDatabase Implementation](../../packages/daemon/src/storage/reactive-database.ts)
- [LiveQueryEngine Implementation](../../packages/daemon/src/storage/live-query.ts)
- [JobQueueRepository Implementation](../../packages/daemon/src/storage/repositories/job-queue-repository.ts)
- [JobQueueProcessor Implementation](../../packages/daemon/src/storage/job-queue-processor.ts)
- [Current StateManager](../../packages/daemon/src/lib/state-manager.ts)
