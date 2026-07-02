# Migration Plan: Live Query Architecture Transition

**Related ADR**: [0001-live-query-and-job-queue.md](./0001-live-query-and-job-queue.md)
**Status**: Proposed
**Last Updated**: 2026-03-01

This document provides a detailed, actionable migration plan for transitioning from manual EventBus broadcasting to Live Query-based state synchronization.

---

## Executive Summary

**Goal**: Replace manual state broadcasting with Live Query so that database writes automatically propagate to clients.

**Duration**: 5 phases over approximately 2-3 weeks

**Risk Level**: Medium (requires parallel-run verification)

**Key Principle**: The database is the message bus. Live Query is the subscription mechanism. No manual broadcasting for DB-backed state.

---

## 1. Current State Analysis

### 1.1 StateManager Broadcast Methods (Manual Broadcasting)

The following methods in `/packages/daemon/src/lib/state-manager.ts` manually broadcast state changes:

| Method | Lines | Trigger | Data Broadcast |
|--------|-------|---------|----------------|
| `broadcastSessionsDelta()` | 562-566 | `session.created`, `session.updated`, `session.deleted` | Added/updated/removed sessions |
| `broadcastSessionsChange()` | 546-555 | `sessions.filterChanged`, archived status | Full sessions list |
| `broadcastSessionUpdateFromCache()` | 224-285 | `session.updated` event | Session state + sidebar update |
| `broadcastSDKMessagesDelta()` | 661-669 | New SDK message | Single message delta |
| `broadcastSDKMessagesChange()` | 647-654 | Message fetch | Full message list |
| `broadcastSessionStateChange()` | 598-641 | `session.updated`, `session.error`, `commands.updated`, `context.updated` | Unified session state |
| `broadcastSystemChange()` | 572-579 | `api.connection`, `auth.changed` | System state (non-DB) |
| `broadcastSettingsChange()` | 584-591 | `settings.updated` | Global settings |

### 1.2 EventBus Events That Trigger Broadcasts

From `/packages/daemon/src/lib/daemon-hub.ts`, events that trigger StateManager broadcasts:

```typescript
// DB-backed events (will migrate to Live Query)
'session.created'     -> broadcastSessionsDelta
'session.updated'     -> broadcastSessionUpdateFromCache -> broadcastSessionsDelta
'session.deleted'     -> broadcastSessionsDelta
'commands.updated'    -> broadcastSessionStateChange
'context.updated'     -> broadcastSessionStateChange
'session.error'       -> broadcastSessionStateChange
'session.errorClear'  -> broadcastSessionStateChange
'sessions.filterChanged' -> broadcastSessionsChange

// Non-DB events (will remain on EventBus)
'api.connection'      -> broadcastSystemChange
'auth.changed'        -> broadcastSystemChange
'settings.updated'    -> broadcastSettingsChange
```

### 1.3 Client-Side StateChannel Subscriptions

From `/packages/web/src/lib/global-store.ts` and `/packages/web/src/lib/state-channel.ts`:

| Channel | Pattern | Current Data Source |
|---------|---------|---------------------|
| `state.sessions` | Full state | StateManager RPC + EventBus |
| `state.sessions.delta` | Delta updates | StateManager broadcasts |
| `state.system` | Full state | StateManager RPC + EventBus |
| `state.settings` | Full state | StateManager RPC + EventBus |
| `state.session` | Per-session state | StateManager RPC + EventBus |
| `state.sdkMessages` | Per-session messages | StateManager RPC + EventBus |
| `state.sdkMessages.delta` | Message deltas | StateManager broadcasts |

### 1.4 Existing Infrastructure (Already Implemented)

| Component | File | Status |
|-----------|------|--------|
| ReactiveDatabase | `packages/daemon/src/storage/reactive-database.ts` | Complete |
| LiveQueryEngine | `packages/daemon/src/storage/live-query.ts` | Complete |
| JobQueueRepository | `packages/daemon/src/storage/repositories/job-queue-repository.ts` | Complete |
| JobQueueProcessor | `packages/daemon/src/storage/job-queue-processor.ts` | Complete (not wired) |

### 1.5 Key Files to Modify

```
packages/daemon/
  src/
    app.ts                                    # Wire JobQueueProcessor
    lib/
      state-manager.ts                        # Remove broadcast methods
      rpc-handlers/
        live-query-handlers.ts               # NEW: RPC endpoints
    storage/
      live-query.ts                          # Already complete

packages/shared/
  src/
    state-types.ts                           # Add LiveQuery types

packages/web/
  src/
    lib/
      global-store.ts                        # Use LiveQueryChannel
      session-store.ts                       # Use LiveQueryChannel
      live-query-channel.ts                  # NEW: Client-side wrapper
```

---

## 2. Target State

### 2.1 Architecture After Migration

```
+-------------------+     +------------------+     +-------------------+
|  Write Operation  |     | ReactiveDatabase |     | LiveQueryEngine   |
|  (Repository)     |---->|  (Proxy)         |---->|  (Subscriptions)  |
+-------------------+     +------------------+     +-------------------+
                                                         |
                                                         v
+-------------------+     +------------------+     +-------------------+
|  WebSocket        |<----|  MessageHub      |<----|  QueryDiff        |
|  (Client)         |     |  (RPC + Pub/Sub) |     |  Callback         |
+-------------------+     +------------------+     +-------------------+
```

### 2.2 State Channel Mapping

| Channel | Before | After |
|---------|--------|-------|
| `state.sessions` | StateManager RPC + EventBus | LiveQuery: `SELECT * FROM sessions WHERE status != 'archived'` |
| `state.sessions.delta` | StateManager broadcast | LiveQuery delta (added/removed/updated) |
| `state.sdkMessages` | StateManager RPC | LiveQuery: `SELECT * FROM sdk_messages WHERE session_id = ?` |
| `state.sdkMessages.delta` | StateManager broadcast | LiveQuery delta |
| `state.system` | EventBus (auth, config) | **UNCHANGED** (non-DB state) |
| `state.settings` | EventBus | LiveQuery: `SELECT * FROM global_settings` |
| `state.jobs` | N/A | LiveQuery: `SELECT * FROM job_queue WHERE queue = ?` |

### 2.3 Simplified StateManager

After migration, StateManager will only handle:

- Non-DB state (`state.system` - auth status, API connection, health)
- Transient state (agent processing state, connection status)
- Snapshot RPC handlers (delegating to LiveQuery for DB data)

Estimated reduction: ~400 lines of code removed.

---

## 3. Migration Steps (Detailed)

### Phase 0: Foundation

**Goal**: Wire JobQueueProcessor into app lifecycle without changing behavior.

**Duration**: 1 day

#### Tasks

- [ ] **0.1** Create `JobQueueProcessor` instance in `app.ts`

```typescript
// packages/daemon/src/app.ts
import { JobQueueProcessor } from './storage/job-queue-processor';
import { JobQueueRepository } from './storage/repositories/job-queue-repository';

// In createDaemonApp():
const jobQueueRepo = new JobQueueRepository(db.getDatabase());
const jobQueueProcessor = new JobQueueProcessor(jobQueueRepo, {
  pollIntervalMs: 1000,
  maxConcurrent: 3,
});

// Start processor
jobQueueProcessor.start();

// In cleanup():
jobQueueProcessor.stop();
```

- [ ] **0.2** Add to `DaemonAppContext`

```typescript
export interface DaemonAppContext {
  // ... existing fields
  jobQueueProcessor: JobQueueProcessor;
}
```

- [ ] **0.3** Register cleanup in app shutdown

#### Files to Modify

| File | Change |
|------|--------|
| `packages/daemon/src/app.ts` | Create and wire JobQueueProcessor |

#### Testing Approach

- [ ] Unit test: Verify processor starts and stops cleanly
- [ ] Integration test: Verify stale job recovery works

#### Rollback

Remove JobQueueProcessor instantiation and cleanup code.

---

### Phase 1: Live Query RPC

**Goal**: Expose LiveQueryEngine via MessageHub RPC endpoints.

**Duration**: 2-3 days

#### Tasks

- [ ] **1.1** Create `/packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts`

```typescript
// packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts
import type { MessageHub } from '@hyperneo/shared';
import type { LiveQueryEngine } from '../../storage/live-query';
import type { QueryDiff } from '../../storage/live-query';

interface LiveQuerySubscribeRequest {
  sql: string;
  params: unknown[];
  channel: string;  // Broadcast channel for diffs
}

interface LiveQuerySubscribeResponse {
  subscriptionId: string;
  snapshot: QueryDiff;
}

// Track subscriptions per client for cleanup
const clientSubscriptions = new Map<string, Set<string>>();

export function setupLiveQueryHandlers(
  messageHub: MessageHub,
  liveQueries: LiveQueryEngine,
) {
  // Subscribe to a live query
  messageHub.onRequest('liveQuery.subscribe', async (data, context) => {
    const { sql, params, channel } = data as LiveQuerySubscribeRequest;
    const clientId = context?.clientId || 'default';

    const subscriptionId = `${clientId}:${channel}:${Date.now()}`;

    const handle = liveQueries.subscribe(
      sql,
      params,
      (diff: QueryDiff) => {
        // Broadcast diff to channel
        messageHub.event(channel, diff, { channel: 'global' });
      }
    );

    // Track subscription
    if (!clientSubscriptions.has(clientId)) {
      clientSubscriptions.set(clientId, new Set());
    }
    clientSubscriptions.get(clientId)!.add(subscriptionId);

    return {
      subscriptionId,
      snapshot: { type: 'snapshot', rows: handle.get(), version: 0 },
    };
  });

  // Unsubscribe
  messageHub.onRequest('liveQuery.unsubscribe', async (data) => {
    const { subscriptionId } = data as { subscriptionId: string };
    // Dispose the handle (stored separately)
    // Return success
    return { success: true };
  });

  // Cleanup on client disconnect
  // (Wire into WebSocket close handler)
}
```

- [ ] **1.2** Add types to `/packages/shared/src/state-types.ts`

```typescript
// Add to state-types.ts

export interface LiveQuerySubscription {
  subscriptionId: string;
  sql: string;
  params: unknown[];
  channel: string;
}

export interface LiveQuerySnapshot<T> {
  type: 'snapshot';
  rows: T[];
  version: number;
}

export interface LiveQueryDelta<T> {
  type: 'delta';
  rows: T[];
  added?: T[];
  removed?: T[];
  updated?: T[];
  version: number;
}
```

- [ ] **1.3** Create `/packages/web/src/lib/live-query-channel.ts`

```typescript
// packages/web/src/lib/live-query-channel.ts
import { signal, type Signal, batch } from '@preact/signals';
import type { MessageHub } from '@hyperneo/shared';
import type { QueryDiff } from '@hyperneo/shared';

export interface LiveQueryChannelOptions {
  sql: string;
  params: unknown[];
  channel: string;
}

export class LiveQueryChannel<T extends Record<string, unknown>> {
  private state = signal<T[]>([]);
  private version = signal<number>(0);
  private subscriptionId: string | null = null;
  private unsubEvent: (() => void) | null = null;

  constructor(
    private hub: MessageHub,
    private options: LiveQueryChannelOptions
  ) {}

  async start(): Promise<void> {
    // 1. Subscribe to broadcast channel
    this.unsubEvent = this.hub.onEvent<QueryDiff<T>>(
      this.options.channel,
      (diff) => this.handleDiff(diff)
    );

    // 2. Subscribe via RPC
    const response = await this.hub.request<{
      subscriptionId: string;
      snapshot: QueryDiff<T>;
    }>('liveQuery.subscribe', this.options);

    this.subscriptionId = response.subscriptionId;
    this.handleDiff(response.snapshot);
  }

  private handleDiff(diff: QueryDiff<T>): void {
    batch(() => {
      this.state.value = diff.rows;
      this.version.value = diff.version;
    });
  }

  get rows(): Signal<T[]> {
    return this.state;
  }

  get currentVersion(): Signal<number> {
    return this.version;
  }

  async stop(): Promise<void> {
    if (this.unsubEvent) {
      this.unsubEvent();
      this.unsubEvent = null;
    }
    if (this.subscriptionId) {
      await this.hub.request('liveQuery.unsubscribe', {
        subscriptionId: this.subscriptionId
      });
      this.subscriptionId = null;
    }
  }
}
```

- [ ] **1.4** Register handlers in `/packages/daemon/src/lib/rpc-handlers/index.ts`

```typescript
// Add to imports
import { setupLiveQueryHandlers } from './live-query-handlers';

// Add to RPCHandlerDependencies
export interface RPCHandlerDependencies {
  // ... existing
  liveQueries: LiveQueryEngine;
}

// Add to setupRPCHandlers()
setupLiveQueryHandlers(deps.messageHub, deps.liveQueries);
```

#### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts` | CREATE | RPC endpoints |
| `packages/shared/src/state-types.ts` | MODIFY | Add LiveQuery types |
| `packages/web/src/lib/live-query-channel.ts` | CREATE | Client wrapper |
| `packages/daemon/src/lib/rpc-handlers/index.ts` | MODIFY | Register handlers |
| `packages/daemon/src/app.ts` | MODIFY | Pass liveQueries to handlers |

#### Testing Approach

- [ ] Unit test: RPC handler with mock LiveQueryEngine
- [ ] Unit test: LiveQueryChannel subscription lifecycle
- [ ] Integration test: Subscribe -> Insert -> Receive delta
- [ ] Integration test: Auto-cleanup on disconnect

#### Rollback

Remove live-query-handlers.ts and LiveQueryChannel.ts. Revert index.ts and app.ts changes.

---

### Phase 2: Parallel Run (Sessions)

**Goal**: Run both manual broadcast and Live Query in parallel, verify consistency.

**Duration**: 3-4 days

#### Tasks

- [ ] **2.1** Add feature flag to settings

```typescript
// packages/shared/src/types/settings.ts
interface GlobalSettings {
  // ... existing
  useLiveQueryForSessions?: boolean;  // Default: false
}
```

- [ ] **2.2** Create parallel subscription in `global-store.ts`

```typescript
// packages/web/src/lib/global-store.ts
export class GlobalStore {
  private sessionsLiveQuery: LiveQueryChannel<SessionRow> | null = null;

  async initialize(): Promise<void> {
    // ... existing subscriptions ...

    // Parallel run: Also subscribe via Live Query if enabled
    if (this.settings.value?.useLiveQueryForSessions) {
      this.sessionsLiveQuery = new LiveQueryChannel(hub, {
        sql: `SELECT * FROM sessions WHERE status != 'archived' ORDER BY last_active_at DESC`,
        params: [],
        channel: 'state.sessions.live',
      });

      await this.sessionsLiveQuery.start();

      // Log diffs for comparison
      this.sessionsLiveQuery.rows.subscribe((rows) => {
        console.log('[LiveQuery] sessions updated:', rows.length);
      });
    }
  }
}
```

- [ ] **2.3** Add diff verification logging

```typescript
// In global-store.ts
private comparePaths(): void {
  if (!this.sessionsLiveQuery) return;

  const eventBusSessions = this.sessions.value;
  const liveQuerySessions = this.sessionsLiveQuery.rows.value;

  // Compare by ID set
  const eventBusIds = new Set(eventBusSessions.map(s => s.id));
  const liveQueryIds = new Set(liveQuerySessions.map(s => s.id));

  const missing = [...eventBusIds].filter(id => !liveQueryIds.has(id));
  const extra = [...liveQueryIds].filter(id => !eventBusIds.has(id));

  if (missing.length > 0 || extra.length > 0) {
    console.error('[Migration] Session divergence!', { missing, extra });
  }
}
```

- [ ] **2.4** Run for 1-2 days, analyze logs for discrepancies

#### Files to Modify

| File | Change |
|------|--------|
| `packages/shared/src/types/settings.ts` | Add feature flag |
| `packages/web/src/lib/global-store.ts` | Add parallel LiveQuery subscription |

#### Testing Approach

- [ ] Manual testing: Enable flag, create/update/delete sessions
- [ ] Monitor console logs for divergence warnings
- [ ] E2E test: Session operations with flag on/off

#### Rollback

Disable feature flag. No code changes required.

---

### Phase 3: Cutover (Sessions)

**Goal**: Switch clients to use Live Query for sessions by default.

**Duration**: 1-2 days

#### Tasks

- [ ] **3.1** Remove delta handling from global-store, use LiveQuery as primary

```typescript
// packages/web/src/lib/global-store.ts
async initialize(): Promise<void> {
  const hub = await connectionManager.getHub();

  // Use Live Query for sessions
  this.sessionsLiveQuery = new LiveQueryChannel(hub, {
    sql: `SELECT * FROM sessions WHERE status != 'archived' ORDER BY last_active_at DESC`,
    params: [],
    channel: 'state.sessions.live',
  });

  await this.sessionsLiveQuery.start();

  // Link LiveQuery to signals
  this.sessions = this.sessionsLiveQuery.rows;
}
```

- [ ] **3.2** Update server-side to broadcast to Live Query channel

```typescript
// In live-query-handlers.ts
// The LiveQueryEngine already broadcasts to the channel
// when the query results change
```

- [ ] **3.3** Keep manual broadcast code for now (can be removed in Phase 4)

#### Files to Modify

| File | Change |
|------|--------|
| `packages/web/src/lib/global-store.ts` | Use LiveQuery as primary source |

#### Testing Approach

- [ ] E2E test: Create session -> verify sidebar update
- [ ] E2E test: Archive session -> verify removal from list
- [ ] E2E test: Update session (title change) -> verify sidebar
- [ ] Load test: Create 50 sessions rapidly -> verify no missing updates

#### Rollback

Revert global-store.ts to use EventBus subscriptions.

---

### Phase 4: Cleanup (Remove Manual Broadcasting)

**Goal**: Remove manual broadcast code from StateManager for DB-backed state.

**Duration**: 2-3 days

#### Tasks

- [ ] **4.1** Remove sessions-related broadcast methods

```typescript
// packages/daemon/src/lib/state-manager.ts

// REMOVE these methods:
// - broadcastSessionsDelta()
// - broadcastSessionsChange()
// - broadcastSessionUpdateFromCache() (keep for processing state)
```

- [ ] **4.2** Remove SDK messages broadcast methods

```typescript
// packages/daemon/src/lib/state-manager.ts

// REMOVE these methods:
// - broadcastSDKMessagesDelta()
// - broadcastSDKMessagesChange()
```

- [ ] **4.3** Remove related EventBus listeners

```typescript
// packages/daemon/src/lib/state-manager.ts
// In setupEventListeners():

// REMOVE or SIMPLIFY these listeners:
this.eventBus.on('session.created', ...)   // Keep only for non-DB state
this.eventBus.on('session.updated', ...)   // Keep only for processing state
this.eventBus.on('session.deleted', ...)   // Keep only for cache cleanup
```

- [ ] **4.4** Update session-store.ts to use LiveQuery

```typescript
// packages/web/src/lib/session-store.ts
// Replace StateChannel with LiveQueryChannel for SDK messages
```

- [ ] **4.5** Simplify StateManager

Final StateManager should only handle:
- `state.system` (auth, config, health, API connection)
- Agent processing state (in-memory only)
- Error state (in-memory cache)

#### Code Removals

| Method | Lines | Reason |
|--------|-------|--------|
| `broadcastSessionsDelta()` | 562-566 | Replaced by LiveQuery |
| `broadcastSessionsChange()` | 546-555 | Replaced by LiveQuery |
| `broadcastSDKMessagesDelta()` | 661-669 | Replaced by LiveQuery |
| `broadcastSDKMessagesChange()` | 647-654 | Replaced by LiveQuery |
| `broadcastSessionUpdateFromCache()` (sessions part) | 224-285 | Partially replaced |

#### Files to Modify

| File | Change |
|------|--------|
| `packages/daemon/src/lib/state-manager.ts` | Remove ~300 lines |
| `packages/web/src/lib/session-store.ts` | Use LiveQueryChannel |
| `packages/web/src/lib/global-store.ts` | Remove delta handlers |

#### Testing Approach

- [ ] Full regression test: All session operations
- [ ] Full regression test: All message operations
- [ ] E2E test suite pass
- [ ] Performance test: Compare latency before/after

#### Rollback

Git revert the cleanup commit. Manual broadcast code restored.

---

### Phase 5: Job Queue Integration

**Goal**: Wire JobQueueProcessor handlers and add job status live queries.

**Duration**: 1-2 days

#### Tasks

- [ ] **5.1** Register job handlers

```typescript
// packages/daemon/src/app.ts
jobQueueProcessor.register('github-polling', async (job) => {
  // Handle GitHub API polling
  return { processed: true };
});

jobQueueProcessor.register('notification', async (job) => {
  // Handle deferred notifications
  return { sent: true };
});
```

- [ ] **5.2** Add job status live query

```typescript
// packages/web/src/lib/job-store.ts
export class JobStore {
  private jobsLiveQuery: LiveQueryChannel<JobRow>;

  async subscribe(queue: string): Promise<void> {
    this.jobsLiveQuery = new LiveQueryChannel(hub, {
      sql: `SELECT * FROM job_queue WHERE queue = ? AND status IN ('pending', 'running') ORDER BY created_at ASC`,
      params: [queue],
      channel: `state.jobs.${queue}`,
    });

    await this.jobsLiveQuery.start();
  }
}
```

- [ ] **5.3** Wire processor change notifier

```typescript
// packages/daemon/src/app.ts
jobQueueProcessor.setChangeNotifier((table) => {
  reactiveDb.notifyChange(table);
});
```

#### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/daemon/src/app.ts` | MODIFY | Register handlers |
| `packages/web/src/lib/job-store.ts` | CREATE | Job status tracking |

#### Testing Approach

- [ ] Unit test: Job handler execution
- [ ] Integration test: Enqueue -> Process -> Live query update
- [ ] E2E test: Job status UI updates

#### Rollback

Remove job handlers. Job status live query is additive, no removal needed.

---

## 4. Specific Code Removals

### Methods to Remove from `/packages/daemon/src/lib/state-manager.ts`

```typescript
// Lines 562-566
async broadcastSessionsDelta(update: SessionsUpdate): Promise<void> { ... }

// Lines 546-555
async broadcastSessionsChange(sessions?: Session[]): Promise<void> { ... }

// Lines 661-669
async broadcastSDKMessagesDelta(sessionId: string, update: SDKMessagesUpdate): Promise<void> { ... }

// Lines 647-654
async broadcastSDKMessagesChange(sessionId: string): Promise<void> { ... }
```

### Methods to Simplify (Keep for Non-DB State)

```typescript
// Keep but simplify:
broadcastSessionUpdateFromCache()  // Only for processing state, not session metadata
broadcastSessionStateChange()      // Keep for agent state, error state
broadcastSystemChange()            // Keep (non-DB state)
broadcastSettingsChange()          // Consider migrating settings to Live Query
```

### EventBus Events to Remove/Modify

```typescript
// Remove broadcasting from these events (keep event emission for other listeners):
'session.created'   // Keep event, remove StateManager broadcast
'session.updated'   // Keep event, remove StateManager broadcast for DB fields
'session.deleted'   // Keep event, remove StateManager broadcast
```

---

## 5. Testing Strategy

### 5.1 Unit Tests

| Component | Test File | Coverage |
|-----------|-----------|----------|
| LiveQueryEngine | `packages/daemon/tests/unit/storage/live-query.test.ts` | Already complete |
| ReactiveDatabase | `packages/daemon/tests/unit/storage/reactive-database.test.ts` | Already complete |
| Live Query RPC | `packages/daemon/tests/unit/rpc-handlers/live-query-handlers.test.ts` | NEW |
| LiveQueryChannel | `packages/web/src/lib/__tests__/live-query-channel.test.ts` | NEW |
| JobQueueProcessor | `packages/daemon/tests/unit/storage/job-queue-processor.test.ts` | Already complete |

### 5.2 Integration Tests

```typescript
// packages/daemon/tests/integration/live-query-flow.test.ts
describe('Live Query Integration', () => {
  test('session insert triggers live query delta', async () => {
    // 1. Subscribe to sessions live query
    // 2. Insert session via repository
    // 3. Verify delta received with added session
  });

  test('SDK message insert triggers live query delta', async () => {
    // 1. Subscribe to messages live query
    // 2. Insert message via repository
    // 3. Verify delta received with added message
  });
});
```

### 5.3 E2E Tests

```typescript
// packages/e2e/tests/features/live-query-sessions.e2e.ts
test('session list updates via live query', async ({ page }) => {
  // 1. Load app
  // 2. Create session via UI
  // 3. Verify sidebar shows new session
  // 4. Archive session
  // 5. Verify session removed from sidebar
});

test('session list updates on reconnect', async ({ page }) => {
  // 1. Load app
  // 2. Close WebSocket
  // 3. Create session on server (direct DB)
  // 4. Restore WebSocket
  // 5. Verify session appears in sidebar
});
```

### 5.4 Performance Benchmarks

| Metric | Baseline | Target |
|--------|----------|--------|
| Session list update latency | ~50ms | <30ms |
| Message delta latency | ~30ms | <20ms |
| Memory per subscription | N/A | <1KB |
| CPU overhead (idle) | 0% | <1% |

---

## 6. Rollback Plan

### Per-Phase Rollback

| Phase | Rollback Command | Risk |
|-------|-----------------|------|
| Phase 0 | `git revert <commit>` | Low - additive only |
| Phase 1 | Remove handlers, delete new files | Low - not used yet |
| Phase 2 | Disable feature flag | Very Low - config change only |
| Phase 3 | Revert global-store changes | Medium - clients need refresh |
| Phase 4 | `git revert <cleanup-commit>` | High - requires re-deploy |
| Phase 5 | Remove job handlers | Low - additive only |

### Full Rollback

If critical issues arise after Phase 4:

```bash
# 1. Revert to pre-migration commit
git revert <phase-4-commit>
git revert <phase-3-commit>
git revert <phase-2-commit>

# 2. Re-deploy daemon
make compile && <deploy-command>

# 3. Clients auto-reconnect and use old path
```

### Monitoring During Migration

Add alerts for:
- WebSocket message rate drop (indicates clients not receiving updates)
- Session list query latency spike
- Error rate in StateManager broadcast methods

---

## 7. Open Questions

1. **Settings migration**: Should `global_settings` also move to Live Query, or keep on EventBus? Settings change infrequently.

2. **Pagination**: How to handle large message lists? Cursor-based pagination with Live Query?

3. **Binary data**: Should we exclude large columns (e.g., message content) from live queries to reduce payload?

4. **Room/task tables**: These already use direct DB reads. Should they also migrate to Live Query in a future phase?

---

## 8. Checklist Summary

### Phase 0: Foundation
- [ ] Wire JobQueueProcessor in app.ts
- [ ] Unit tests pass

### Phase 1: Live Query RPC
- [ ] Create live-query-handlers.ts
- [ ] Create LiveQueryChannel.ts
- [ ] Add types to shared
- [ ] Register handlers
- [ ] Unit tests pass
- [ ] Integration tests pass

### Phase 2: Parallel Run
- [ ] Add feature flag
- [ ] Parallel subscription in global-store
- [ ] Diff verification logging
- [ ] 1-2 days monitoring

### Phase 3: Cutover
- [ ] Switch global-store to Live Query
- [ ] E2E tests pass
- [ ] Performance benchmarks pass

### Phase 4: Cleanup
- [ ] Remove broadcastSessionsDelta
- [ ] Remove broadcastSessionsChange
- [ ] Remove broadcastSDKMessagesDelta
- [ ] Remove broadcastSDKMessagesChange
- [ ] Simplify StateManager
- [ ] Full regression tests pass

### Phase 5: Job Queue
- [ ] Register job handlers
- [ ] Create job-store.ts
- [ ] Wire change notifier
- [ ] Tests pass
