import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';
import { createSpaceTables } from '../../helpers/space-test-db';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('TaskAgentManager rate-limit pause/resume listener', () => {
  let db: Database;
  let taskRepo: SpaceTaskRepository;
  let bus: ReturnType<typeof createDaemonInternalEventBus>;
  let manager: TaskAgentManager;
  let taskId: string;
  const subSessionId = 'worker-session-1';

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    const spaceRepo = new SpaceRepository(
      db as unknown as Parameters<typeof SpaceRepository.prototype.constructor>[0]
    );
    const space = spaceRepo.createSpace({ workspacePath: '/w', slug: 's', name: 'S' });
    taskRepo = new SpaceTaskRepository(
      db as unknown as Parameters<typeof SpaceTaskRepository.prototype.constructor>[0]
    );
    const task = taskRepo.createTask({ spaceId: space.id, title: 'T', description: '' });
    taskId = task.id;
    taskRepo.updateTask(taskId, { status: 'in_progress' });

    bus = createDaemonInternalEventBus();

    const config = {
      db: { getDatabase: () => db },
      taskRepo,
      internalEventBus: bus,
    } as unknown as TaskAgentManagerConfig;
    manager = new TaskAgentManager(config);

    const subSessions = (manager as unknown as { subSessions: Map<string, Map<string, unknown>> })
      .subSessions;
    subSessions.set(taskId, new Map());
    subSessions.get(taskId)!.set(subSessionId, { id: subSessionId });
  });

  afterEach(() => {
    db.close();
  });

  it('marks the task usage_limited with a resume-at restriction on pause (usage cap)', async () => {
    const resetAt = Date.now() + 5 * 60 * 60 * 1000;
    bus.publish('session.rate_limit_pause', {
      sessionId: subSessionId,
      kind: 'usage_limit',
      resetAt,
      reason: 'parsed-reset',
    });
    await flush();

    const task = taskRepo.getTask(taskId);
    expect(task?.status).toBe('usage_limited');
    expect(task?.restrictions).toMatchObject({
      type: 'usage_limit',
      resetAt,
      sessionRole: 'worker',
    });
  });

  it('marks the task rate_limited on pause (transient)', async () => {
    bus.publish('session.rate_limit_pause', {
      sessionId: subSessionId,
      kind: 'rate_limit',
      reason: 'backoff-ladder',
    });
    await flush();

    const task = taskRepo.getTask(taskId);
    expect(task?.status).toBe('rate_limited');
    expect(task?.restrictions?.type).toBe('rate_limit');
  });

  it('records a billing-terminal pause with its reason so recovery stays manual-only', async () => {
    bus.publish('session.rate_limit_pause', {
      sessionId: subSessionId,
      kind: 'usage_limit',
      reason: 'billing-terminal',
    });
    await flush();

    const task = taskRepo.getTask(taskId);
    expect(task?.status).toBe('usage_limited');
    expect(task?.restrictions?.limit).toBe('billing-terminal');
    expect(task?.restrictions?.resetAt).toBeDefined();
  });

  it('restores the task to in_progress and clears restrictions on resume', async () => {
    const resetAt = Date.now() + 60 * 60 * 1000;
    bus.publish('session.rate_limit_pause', {
      sessionId: subSessionId,
      kind: 'usage_limit',
      resetAt,
      reason: 'parsed-reset',
    });
    await flush();
    expect(taskRepo.getTask(taskId)?.status).toBe('usage_limited');

    bus.publish('session.rate_limit_resume', { sessionId: subSessionId });
    await flush();

    const task = taskRepo.getTask(taskId);
    expect(task?.status).toBe('in_progress');
    expect(task?.restrictions).toBeNull();
  });

  it('ignores pause events for an unknown session (no parent task)', async () => {
    bus.publish('session.rate_limit_pause', {
      sessionId: 'not-a-known-session',
      kind: 'usage_limit',
      resetAt: Date.now() + 60000,
      reason: 'parsed-reset',
    });
    await flush();
    expect(taskRepo.getTask(taskId)?.status).toBe('in_progress');
  });

  it('does not override a terminal/blocked status on pause (done/blocked/cancelled/archived)', async () => {
    for (const terminal of ['done', 'blocked', 'cancelled', 'archived'] as const) {
      taskRepo.updateTask(taskId, { status: 'in_progress' });
      taskRepo.updateTask(taskId, { status: terminal });
      bus.publish('session.rate_limit_pause', {
        sessionId: subSessionId,
        kind: 'usage_limit',
        resetAt: Date.now() + 60000,
        reason: 'parsed-reset',
      });
      await flush();
      expect(taskRepo.getTask(taskId)?.status).toBe(terminal);
    }
  });

  it('a late resume does not resurrect a terminal task (cancelled/done/archived)', async () => {
    for (const terminal of ['cancelled', 'done', 'archived'] as const) {
      taskRepo.updateTask(taskId, {
        status: 'usage_limited',
        restrictions: {
          type: 'usage_limit',
          limit: 'parsed-reset',
          resetAt: Date.now() + 60000,
          sessionRole: 'worker',
        },
      });
      taskRepo.updateTask(taskId, { status: terminal });
      expect(taskRepo.getTask(taskId)?.restrictions).toBeNull();

      bus.publish('session.rate_limit_resume', { sessionId: subSessionId });
      await flush();
      const task = taskRepo.getTask(taskId);
      expect(task?.status).toBe(terminal);
      expect(task?.restrictions).toBeNull();
    }
  });

  it('resume is a no-op when the task is not currently limited', async () => {
    bus.publish('session.rate_limit_resume', { sessionId: subSessionId });
    await flush();
    expect(taskRepo.getTask(taskId)?.status).toBe('in_progress');
    expect(taskRepo.getTask(taskId)?.restrictions).toBeNull();
  });

  it('does not restore until every limited sub-session for the task resumes', async () => {
    const secondSession = 'worker-session-2';
    const subSessions = (manager as unknown as { subSessions: Map<string, Map<string, unknown>> })
      .subSessions;
    subSessions.get(taskId)!.set(secondSession, { id: secondSession });

    bus.publish('session.rate_limit_pause', {
      sessionId: subSessionId,
      kind: 'usage_limit',
      resetAt: Date.now() + 60000,
      reason: 'parsed-reset',
    });
    bus.publish('session.rate_limit_pause', {
      sessionId: secondSession,
      kind: 'usage_limit',
      resetAt: Date.now() + 60000,
      reason: 'parsed-reset',
    });
    await flush();
    expect(taskRepo.getTask(taskId)?.status).toBe('usage_limited');

    bus.publish('session.rate_limit_resume', { sessionId: subSessionId });
    await flush();
    expect(taskRepo.getTask(taskId)?.status).toBe('usage_limited');

    bus.publish('session.rate_limit_resume', { sessionId: secondSession });
    await flush();
    expect(taskRepo.getTask(taskId)?.status).toBe('in_progress');
    expect(taskRepo.getTask(taskId)?.restrictions).toBeNull();
  });

  it('does not pause a task that is not in_progress (preserves review/approved)', async () => {
    for (const nonProgress of ['review', 'approved', 'open'] as const) {
      taskRepo.updateTask(taskId, { status: 'in_progress' });
      taskRepo.updateTask(taskId, { status: nonProgress });
      bus.publish('session.rate_limit_pause', {
        sessionId: subSessionId,
        kind: 'usage_limit',
        resetAt: Date.now() + 60000,
        reason: 'parsed-reset',
      });
      await flush();
      expect(taskRepo.getTask(taskId)?.status).toBe(nonProgress);
      expect(taskRepo.getTask(taskId)?.restrictions).toBeNull();
    }
  });

  it('merges a later resetAt (and stronger kind) when a second session pauses', async () => {
    const secondSession = 'worker-session-2';
    const subSessions = (manager as unknown as { subSessions: Map<string, Map<string, unknown>> })
      .subSessions;
    subSessions.get(taskId)!.set(secondSession, { id: secondSession });

    const nearReset = Date.now() + 10 * 60 * 1000;
    bus.publish('session.rate_limit_pause', {
      sessionId: subSessionId,
      kind: 'rate_limit',
      resetAt: nearReset,
      reason: 'backoff-ladder',
    });
    await flush();
    expect(taskRepo.getTask(taskId)?.status).toBe('rate_limited');
    expect(taskRepo.getTask(taskId)?.restrictions?.resetAt).toBe(nearReset);

    const farReset = Date.now() + 30 * 60 * 1000;
    bus.publish('session.rate_limit_pause', {
      sessionId: secondSession,
      kind: 'usage_limit',
      resetAt: farReset,
      reason: 'parsed-reset',
    });
    await flush();
    const task = taskRepo.getTask(taskId);
    expect(task?.status).toBe('usage_limited');
    expect(task?.restrictions?.resetAt).toBe(farReset);
  });

  it('recomputes the restriction on partial resume (cross-restart resetAt reflects only remaining sessions)', async () => {
    const secondSession = 'worker-session-2';
    const subSessions = (manager as unknown as { subSessions: Map<string, Map<string, unknown>> })
      .subSessions;
    subSessions.get(taskId)!.set(secondSession, { id: secondSession });

    const farReset = Date.now() + 30 * 60 * 1000;
    bus.publish('session.rate_limit_pause', {
      sessionId: subSessionId,
      kind: 'usage_limit',
      resetAt: farReset,
      reason: 'parsed-reset',
    });
    await flush();
    expect(taskRepo.getTask(taskId)?.status).toBe('usage_limited');
    expect(taskRepo.getTask(taskId)?.restrictions?.resetAt).toBe(farReset);

    const nearReset = Date.now() + 10 * 60 * 1000;
    bus.publish('session.rate_limit_pause', {
      sessionId: secondSession,
      kind: 'rate_limit',
      resetAt: nearReset,
      reason: 'backoff-ladder',
    });
    await flush();
    const merged = taskRepo.getTask(taskId);
    expect(merged?.status).toBe('usage_limited');
    expect(merged?.restrictions?.resetAt).toBe(farReset);

    bus.publish('session.rate_limit_resume', { sessionId: subSessionId });
    await flush();
    const afterPartial = taskRepo.getTask(taskId);
    expect(afterPartial?.status).toBe('rate_limited');
    expect(afterPartial?.restrictions?.type).toBe('rate_limit');
    expect(afterPartial?.restrictions?.resetAt).toBe(nearReset);

    bus.publish('session.rate_limit_resume', { sessionId: secondSession });
    await flush();
    const restored = taskRepo.getTask(taskId);
    expect(restored?.status).toBe('in_progress');
    expect(restored?.restrictions).toBeNull();
  });
});
