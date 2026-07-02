# ADR 0002: Job Queue Migration Plan

## Status

Proposed

## Context

### Current State

The HyperNeo codebase has a Job Queue infrastructure partially implemented but not yet integrated into the application lifecycle. This document provides a detailed migration plan to wire the Job Queue into the daemon and migrate existing background tasks from setInterval-based polling to job-based execution.

### Existing Infrastructure

| Component | File | Lines | Status |
|-----------|------|-------|--------|
| JobQueueRepository | `packages/daemon/src/storage/repositories/job-queue-repository.ts` | 211 | Complete, integrated with Database facade |
| JobQueueProcessor | `packages/daemon/src/storage/job-queue-processor.ts` | 123 | Complete, NOT wired to app lifecycle |
| job_queue table | Schema migration | - | Created with indexes |
| Unit Tests | `tests/unit/storage/job-queue-*.test.ts` | - | Comprehensive coverage |

### Background Tasks Using setInterval

| Service | File | Interval | Current Pattern |
|---------|------|----------|-----------------|
| GitHub Polling | `packages/daemon/src/lib/github/polling-service.ts` | 60s | setInterval in class |
| Room Runtime Tick | `packages/daemon/src/lib/room/room-runtime.ts` | 30s | setInterval in class |
| WebSocket Stale Check | `packages/daemon/src/lib/websocket-server-transport.ts` | - | setInterval in class |

### Job Data Structure

```typescript
interface Job {
  id: string;
  queue: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'dead';
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  maxRetries: number;
  retryCount: number;
  runAt: number;          // Scheduled execution time (epoch ms)
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}
```

### Key Integration Points

1. **ReactiveDatabase** - Already wired in app.ts, emits `change` events on table writes
2. **LiveQueryEngine** - Already wired in app.ts, subscribes to ReactiveDatabase changes
3. **JobQueueProcessor.setChangeNotifier()** - Exists but not connected to ReactiveDatabase

## Migration Phases

### Phase 1: Wire Processor to App Lifecycle

**Risk Level: Low**

**Goal:** Create and start/stop JobQueueProcessor as part of DaemonApp lifecycle.

#### Changes Required

**File: `packages/daemon/src/app.ts`**

```typescript
// Add imports
import { JobQueueRepository } from './storage/repositories/job-queue-repository';
import { JobQueueProcessor } from './storage/job-queue-processor';

// In DaemonAppContext interface, add:
export interface DaemonAppContext {
  // ... existing fields ...
  /** Job queue processor for background tasks */
  jobProcessor: JobQueueProcessor;
  /** Job queue repository for enqueueing jobs */
  jobQueue: JobQueueRepository;
}

// In createDaemonApp(), after database initialization:
const jobQueue = new JobQueueRepository(db.getDatabase());
const jobProcessor = new JobQueueProcessor(jobQueue, {
  pollIntervalMs: 1000,      // Check for jobs every second
  maxConcurrent: 3,          // Process up to 3 jobs concurrently
  staleThresholdMs: 5 * 60 * 1000,  // Reclaim jobs stuck > 5 min
});

// Start processor before server starts
jobProcessor.start();
logInfo('[Daemon] Job queue processor started');

// In cleanup(), before other cleanup:
await jobProcessor.stop();
logInfo('[Daemon] Job queue processor stopped');

// Return in context
return {
  // ... existing fields ...
  jobProcessor,
  jobQueue,
};
```

#### Testing Approach

- [ ] Unit test: Verify processor starts and stops cleanly
- [ ] Integration test: Verify cleanup waits for in-flight jobs
- [ ] Manual test: Start daemon, enqueue job via debugger, verify processing

#### Rollback

Remove JobQueueProcessor-related code from app.ts. No database changes to revert.

---

### Phase 2: Connect ReactiveDatabase for Change Notifications

**Risk Level: Low**

**Goal:** Wire JobQueueProcessor's change notifier to ReactiveDatabase to enable live query support for job status.

#### Changes Required

**File: `packages/daemon/src/app.ts`**

```typescript
// After jobProcessor creation:
jobProcessor.setChangeNotifier((table) => {
  reactiveDb.notifyChange(table);
});
```

**File: `packages/daemon/src/storage/reactive-database.ts`**

Add `job_queue` to the `METHOD_TABLE_MAP` if jobs are enqueued via Database facade methods. If jobs are enqueued directly via JobQueueRepository (current pattern), the manual `notifyChange()` call above is sufficient.

#### Live Query Subscription Pattern

Clients can now subscribe to job status changes:

```typescript
// Client-side subscription (via future liveQuery.subscribe RPC)
liveQuery.subscribe({
  sql: "SELECT * FROM job_queue WHERE queue = ? AND status IN ('pending', 'processing')",
  params: ['github_poll'],
  channel: 'state.jobs.github_poll'
});
```

#### Testing Approach

- [ ] Unit test: Verify change notifier is called after job completion
- [ ] Integration test: Verify LiveQueryEngine receives job_queue changes
- [ ] Manual test: Subscribe to job changes, enqueue job, verify notification

#### Rollback

Remove `setChangeNotifier()` call. Job processing continues without live query support.

---

### Phase 3: Create Job Handler Modules

**Risk Level: Medium**

**Goal:** Create handler modules for each queue type with clear interfaces.

#### Handler Pattern

**File: `packages/daemon/src/lib/job-handlers/types.ts`**

```typescript
import type { Job } from '../../storage/repositories/job-queue-repository';

export type JobHandler = (job: Job) => Promise<Record<string, unknown> | void>;

export interface JobHandlerContext {
  db: Database;
  daemonHub: DaemonHub;
  config: Config;
  // Additional dependencies per handler
}

export interface JobHandlerRegistration {
  queue: string;
  handler: (context: JobHandlerContext) => JobHandler;
}
```

#### Handler: GitHub Polling

**File: `packages/daemon/src/lib/job-handlers/github-poll.handler.ts`**

```typescript
import type { Job, JobHandler } from './types';
import type { GitHubPollingService } from '../github/polling-service';
import { Logger } from '../logger';

const log = new Logger('github-poll-handler');

interface GitHubPollPayload {
  repositories: Array<{ owner: string; repo: string }>;
}

/**
 * Handles github_poll queue jobs.
 * Polls configured repositories for new issues/comments.
 *
 * Expected payload:
 * {
 *   repositories: [{ owner: 'acme', repo: 'project' }]
 * }
 */
export function createGitHubPollHandler(
  pollingService: GitHubPollingService
): JobHandler {
  return async (job: Job) => {
    const payload = job.payload as GitHubPollPayload;

    // Ensure repositories are registered
    for (const { owner, repo } of payload.repositories ?? []) {
      pollingService.addRepository(owner, repo);
    }

    // Trigger a poll (service handles its own deduplication)
    // The polling service's pollAllRepositories() is private,
    // so we either expose it or refactor slightly.

    log.info('GitHub poll job completed', { jobId: job.id });
    return { polled: payload.repositories?.length ?? 0 };
  };
}
```

**Note:** This requires a small refactor to GitHubPollingService to expose `pollAllRepositories()` or accept external triggers.

#### Handler: Room Runtime Tick

**File: `packages/daemon/src/lib/job-handlers/room-tick.handler.ts`**

```typescript
import type { Job, JobHandler } from './types';
import type { RoomRuntime } from '../room/room-runtime';
import { Logger } from '../logger';

const log = new Logger('room-tick-handler');

interface RoomTickPayload {
  roomId: string;
}

/**
 * Handles room_tick queue jobs.
 * Triggers a single tick of the room runtime.
 *
 * Expected payload:
 * { roomId: 'room-uuid' }
 *
 * Concurrency note: Only one tick per room should run at a time.
 * The RoomRuntime already has tick mutex protection.
 */
export function createRoomTickHandler(
  roomRuntimes: Map<string, RoomRuntime>
): JobHandler {
  return async (job: Job) => {
    const payload = job.payload as RoomTickPayload;
    const runtime = roomRuntimes.get(payload.roomId);

    if (!runtime) {
      log.warn('Room runtime not found', { roomId: payload.roomId });
      return { skipped: true, reason: 'runtime_not_found' };
    }

    // RoomRuntime.tick() is idempotent with mutex protection
    await runtime.tick();

    log.debug('Room tick completed', { roomId: payload.roomId, jobId: job.id });
    return { ticked: true };
  };
}
```

#### Handler: Database Cleanup

**File: `packages/daemon/src/lib/job-handlers/cleanup.handler.ts`**

```typescript
import type { Job, JobHandler } from './types';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import type { Database } from '../../storage/database';
import { Logger } from '../logger';

const log = new Logger('cleanup-handler');

interface CleanupPayload {
  maxAge?: number;  // Age threshold in ms (default: 7 days)
}

/**
 * Handles cleanup queue jobs.
 * Removes old completed/dead jobs and performs other cleanup.
 *
 * Expected payload:
 * { maxAge: 604800000 }  // 7 days in ms
 */
export function createCleanupHandler(
  jobQueue: JobQueueRepository,
  db: Database
): JobHandler {
  return async (job: Job) => {
    const payload = job.payload as CleanupPayload;
    const maxAge = payload.maxAge ?? 7 * 24 * 60 * 60 * 1000; // 7 days
    const threshold = Date.now() - maxAge;

    // Clean up old jobs
    const deletedJobs = jobQueue.cleanup(threshold);

    // Additional cleanup can be added here:
    // - Old SDK messages
    // - Expired sessions
    // - Orphaned records

    log.info('Cleanup job completed', { deletedJobs, threshold });

    return {
      deletedJobs,
      threshold,
    };
  };
}
```

#### Testing Approach

- [ ] Unit test: Each handler with mock dependencies
- [ ] Unit test: Handler error handling and retry behavior
- [ ] Integration test: Handler registration and execution via processor

#### Rollback

Remove handler files. No database changes.

---

### Phase 4: Migrate GitHub Polling

**Risk Level: Medium**

**Goal:** Replace GitHubPollingService's internal setInterval with job-based scheduling.

#### Current Pattern

```typescript
// In GitHubPollingService.start()
this.pollingInterval = setInterval(() => {
  this.pollAllRepositories().catch(...);
}, this.config.interval);
```

#### Target Pattern

```typescript
// In GitHubService.create()
// Schedule recurring job
jobQueue.enqueue({
  queue: 'github_poll',
  payload: { repositories: configuredRepos },
  maxRetries: 3,
  runAt: Date.now(),  // Start immediately
});

// Handler schedules next job after completion
export function createGitHubPollHandler(...): JobHandler {
  return async (job: Job) => {
    // ... do polling ...

    // Schedule next poll
    jobQueue.enqueue({
      queue: 'github_poll',
      payload: { repositories: repos },
      runAt: Date.now() + 60000,  // 60 seconds from now
    });

    return { polled: repos.length };
  };
}
```

#### Implementation Steps

1. **Expose pollAllRepositories()** or create a triggerable method:

```typescript
// In GitHubPollingService
async triggerPoll(): Promise<void> {
  await this.pollAllRepositories();
}
```

2. **Register handler in app.ts:**

```typescript
import { createGitHubPollHandler } from './lib/job-handlers/github-poll.handler';

// After creating jobProcessor:
if (gitHubService) {
  const handler = createGitHubPollHandler(gitHubService.getPollingService());
  jobProcessor.register('github_poll', handler);
}
```

3. **Update GitHubService to schedule initial job:**

```typescript
// In GitHubService.start()
this.jobQueue.enqueue({
  queue: 'github_poll',
  payload: { repositories: this.getPolledRepositories() },
  runAt: Date.now(),
});
```

4. **Remove setInterval from GitHubPollingService:**

```typescript
// Remove:
// this.pollingInterval = setInterval(...)

// Keep start()/stop() for lifecycle but they become no-ops or state flags
```

#### Concurrency Considerations

- Only one `github_poll` job should run at a time
- Use `maxConcurrent: 1` for this queue OR
- Check for existing pending job before scheduling next

#### Testing Approach

- [ ] Unit test: Handler triggers poll and schedules next job
- [ ] Integration test: Full polling cycle via job queue
- [ ] E2E test: Verify GitHub events flow after migration
- [ ] Manual test: Verify no duplicate polls, no missed polls

#### Rollback

1. Restore setInterval in GitHubPollingService
2. Unregister `github_poll` handler
3. Delete any pending `github_poll` jobs: `DELETE FROM job_queue WHERE queue = 'github_poll'`

---

### Phase 5: Migrate Room Runtime Tick

**Risk Level: High**

**Goal:** Replace RoomRuntime's internal setInterval with job-based scheduling.

**Why High Risk:** Room runtime manages agent sessions; incorrect tick behavior could affect task execution.

#### Current Pattern

```typescript
// In RoomRuntime.start()
this.tickTimer = setInterval(() => this.tick(), this.tickInterval);
```

#### Target Pattern

```typescript
// Room runtime no longer owns its tick timer
// Instead, jobs are scheduled for each active room

// Handler (already created in Phase 3)
export function createRoomTickHandler(roomRuntimes: Map<string, RoomRuntime>): JobHandler {
  return async (job: Job) => {
    const { roomId } = job.payload;
    const runtime = roomRuntimes.get(roomId);
    if (runtime) {
      await runtime.tick();
    }
  };
}

// After tick completion, schedule next tick
// This can be done in the handler or in RoomRuntime itself
```

#### Concurrency Considerations

**Critical:** Only one tick per room should run at a time.

The RoomRuntime already has a tick mutex:

```typescript
// In RoomRuntime.tick()
if (this.tickLocked) {
  this.tickQueued = true;
  return;
}
```

However, we should also prevent multiple pending jobs for the same room:

```typescript
// Before enqueueing room tick
const existingPending = jobQueue.listJobs({
  queue: 'room_tick',
  status: 'pending'
});
const hasRoomJob = existingPending.some(j => j.payload.roomId === roomId);
if (!hasRoomJob) {
  jobQueue.enqueue({ queue: 'room_tick', payload: { roomId } });
}
```

Or use a unique constraint:

```sql
-- Add to job_queue schema (migration required)
CREATE UNIQUE INDEX idx_job_queue_room_tick_unique
  ON job_queue(queue, json_extract(payload, '$.roomId'))
  WHERE queue = 'room_tick' AND status IN ('pending', 'processing');
```

#### Implementation Steps

1. **Create RoomRuntimeManager** (if not exists) to track active runtimes:

```typescript
// packages/daemon/src/lib/room/room-runtime-manager.ts
export class RoomRuntimeManager {
  private runtimes = new Map<string, RoomRuntime>();

  register(roomId: string, runtime: RoomRuntime): void {
    this.runtimes.set(roomId, runtime);
  }

  unregister(roomId: string): void {
    this.runtimes.delete(roomId);
  }

  getRuntime(roomId: string): RoomRuntime | undefined {
    return this.runtimes.get(roomId);
  }

  getAllActiveIds(): string[] {
    return Array.from(this.runtimes.keys());
  }
}
```

2. **Register handler in app.ts:**

```typescript
import { createRoomTickHandler } from './lib/job-handlers/room-tick.handler';

// After creating room runtime manager:
jobProcessor.register('room_tick', createRoomTickHandler(roomRuntimeManager));
```

3. **Create scheduler for room ticks:**

```typescript
// packages/daemon/src/lib/job-handlers/room-tick-scheduler.ts
export class RoomTickScheduler {
  private scheduledRooms = new Set<string>();

  constructor(
    private jobQueue: JobQueueRepository,
    private roomManager: RoomRuntimeManager
  ) {}

  scheduleForRoom(roomId: string, delayMs: number = 30000): void {
    if (this.scheduledRooms.has(roomId)) return;

    this.jobQueue.enqueue({
      queue: 'room_tick',
      payload: { roomId },
      runAt: Date.now() + delayMs,
    });
    this.scheduledRooms.add(roomId);
  }

  onTickComplete(roomId: string): void {
    this.scheduledRooms.delete(roomId);
    // Schedule next tick if room still active
    if (this.roomManager.getRuntime(roomId)) {
      this.scheduleForRoom(roomId);
    }
  }
}
```

4. **Update RoomRuntime to remove setInterval:**

```typescript
// Remove tickTimer and setInterval
// start() just sets state
// tick() remains but is only called by job handler
```

5. **Wire scheduler into handler:**

```typescript
export function createRoomTickHandler(
  roomManager: RoomRuntimeManager,
  scheduler: RoomTickScheduler
): JobHandler {
  return async (job: Job) => {
    const { roomId } = job.payload as RoomTickPayload;
    const runtime = roomManager.getRuntime(roomId);

    if (runtime) {
      await runtime.tick();
      // Schedule next tick
      scheduler.onTickComplete(roomId);
    }

    return { roomId };
  };
}
```

#### Testing Approach

- [ ] Unit test: RoomTickScheduler scheduling logic
- [ ] Unit test: Handler calls tick and reschedules
- [ ] Integration test: Multiple rooms ticking independently
- [ ] Load test: Verify no duplicate ticks under load
- [ ] Manual test: Room creates tasks, executes, completes via job queue

#### Rollback

1. Restore setInterval in RoomRuntime.start()
2. Unregister `room_tick` handler
3. Delete pending jobs: `DELETE FROM job_queue WHERE queue = 'room_tick'`

---

## Recurring Job Scheduling

### Pattern

For recurring jobs, the handler schedules the next iteration after successful completion:

```typescript
export function createRecurringHandler(
  jobQueue: JobQueueRepository,
  intervalMs: number
): JobHandler {
  return async (job: Job) => {
    // Do work...

    // Schedule next run
    jobQueue.enqueue({
      queue: job.queue,
      payload: job.payload,
      runAt: Date.now() + intervalMs,
    });

    return { nextRun: Date.now() + intervalMs };
  };
}
```

### Schedules

| Queue | Interval | Notes |
|-------|----------|-------|
| `github_poll` | 60s | Single global job |
| `room_tick` | 30s | One job per active room |
| `cleanup` | 24h | Single global job, low priority |

### Alternative: Job Scheduler Service

Consider creating a dedicated scheduler service for more complex scheduling:

```typescript
// Future: packages/daemon/src/lib/job-scheduler.ts
export class JobScheduler {
  private schedules = new Map<string, ScheduleConfig>();

  scheduleRecurring(config: {
    queue: string;
    payload: Record<string, unknown>;
    intervalMs: number;
    maxInstances?: number;
  }): void;

  cancel(queue: string): void;

  start(): void;
  stop(): void;
}
```

This is optional for the initial migration but may be useful for complex scenarios.

---

## Integration with Live Query

### Client Subscription Example

```typescript
// Frontend subscribes to job status
const subscription = liveQuery.subscribe({
  sql: `
    SELECT id, queue, status, progress, error, created_at, started_at
    FROM job_queue
    WHERE queue = ? AND status IN ('pending', 'processing')
    ORDER BY created_at ASC
  `,
  params: ['github_poll'],
  channel: 'state.jobs.github_poll',
});

subscription.onChange((diff) => {
  if (diff.type === 'snapshot') {
    setJobs(diff.rows);
  } else {
    // Apply delta
    updateJobs(diff.added, diff.removed, diff.updated);
  }
});
```

### RPC Handler (Future)

```typescript
// packages/daemon/src/lib/rpc-handlers/live-query.ts
export function setupLiveQueryHandlers(
  messageHub: MessageHub,
  liveQueries: LiveQueryEngine,
  reactiveDb: ReactiveDatabase
): void {
  messageHub.registerRpcHandler('liveQuery.subscribe', async (params, context) => {
    const { sql, params: queryParams, channel } = params;

    const handle = liveQueries.subscribe(
      sql,
      queryParams,
      (diff) => {
        messageHub.event(channel, diff);
      }
    );

    // Track subscription for cleanup on disconnect
    context.addSubscription(handle);

    return { subscribed: true, channel };
  });
}
```

---

## Open Questions

### 1. Should we have a dedicated job scheduler service?

**Options:**
- A) Handlers schedule next job themselves (current pattern)
- B) Dedicated JobScheduler service manages recurring schedules
- C) Hybrid: Simple recurring jobs use (A), complex schedules use (B)

**Recommendation:** Start with (A), evaluate (B) if complexity grows.

### 2. How to handle long-running jobs?

Room tick could take >1s if multiple groups are processing.

**Options:**
- A) Increase `staleThresholdMs` to accommodate
- B) Jobs report progress and extend their deadline
- C) Split long jobs into smaller chunks

**Recommendation:** Start with (A) with 5-minute threshold, monitor job duration.

### 3. Priority inversion handling?

High-priority job waiting behind many low-priority jobs.

**Options:**
- A) Use priority field, processor always picks highest priority
- B) Implement starvation prevention (boost priority of waiting jobs)
- C) Separate queues for different priority levels

**Recommendation:** Start with (A) since the processor already supports priority ordering.

### 4. Should room tick jobs be unique per room?

**Options:**
- A) Check for existing pending job before scheduling
- B) Add unique constraint in database
- C) Use job deduplication by payload hash

**Recommendation:** Start with (A) for simplicity, add (B) if race conditions observed.

---

## Testing Strategy

### Unit Tests

- [ ] JobQueueRepository operations (already exist)
- [ ] JobQueueProcessor lifecycle (already exist)
- [ ] Each handler with mock dependencies
- [ ] Scheduler logic for recurring jobs
- [ ] Error handling and retry logic

### Integration Tests

- [ ] End-to-end job processing via DaemonApp
- [ ] Live query notifications for job changes
- [ ] Multiple handlers processing concurrently
- [ ] Graceful shutdown with in-flight jobs

### Load Tests

- [ ] High job enqueue rate
- [ ] Long-running jobs with timeout
- [ ] Concurrent room ticks

### Manual Testing Checklist

- [ ] Start daemon, verify processor starts
- [ ] Enqueue job via debugger, verify processing
- [ ] Subscribe to job changes, verify notifications
- [ ] Kill daemon mid-job, verify reclaim on restart
- [ ] GitHub polling works after migration
- [ ] Room tasks execute correctly after migration

---

## Rollback Summary

| Phase | Rollback Steps |
|-------|----------------|
| 1 | Remove processor code from app.ts |
| 2 | Remove setChangeNotifier call |
| 3 | Delete handler files |
| 4 | Restore setInterval in GitHubPollingService, delete github_poll jobs |
| 5 | Restore setInterval in RoomRuntime, delete room_tick jobs |

---

## References

- [ADR 0001: Live Query and Job Queue Architecture](./0001-live-query-and-job-queue.md)
- [JobQueueRepository Implementation](../../packages/daemon/src/storage/repositories/job-queue-repository.ts)
- [JobQueueProcessor Implementation](../../packages/daemon/src/storage/job-queue-processor.ts)
- [ReactiveDatabase Implementation](../../packages/daemon/src/storage/reactive-database.ts)
- [LiveQueryEngine Implementation](../../packages/daemon/src/storage/live-query.ts)
- [GitHubPollingService](../../packages/daemon/src/lib/github/polling-service.ts)
- [RoomRuntime](../../packages/daemon/src/lib/room/room-runtime.ts)
