import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@hyperneo/shared';
import { Database } from '../../../../src/storage';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import {
  SpaceTaskRepository,
  spaceTaskWriter,
  type WriteSpaceTask,
} from '../../../../src/storage/repositories/space-task-repository';

const SESSION_ID = 'worker-session';

describe('space_tasks writes on the gateway lane racing main-thread writers', () => {
  let dir: string;
  let db: Database;
  let tasks: SpaceTaskRepository;
  let writeTask: WriteSpaceTask;
  let taskId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hn-space-task-lane-race-'));
    db = new Database(join(dir, 'daemon.db'));
    await db.initialize(createReactiveDatabase(db));
    const raw = db.getDatabase();
    const space = new SpaceRepository(raw).createSpace({
      workspacePath: dir,
      slug: 'race',
      name: 'Race',
    });
    tasks = new SpaceTaskRepository(raw);
    writeTask = spaceTaskWriter(raw);
    taskId = tasks.createTask({ spaceId: space.id, title: 'Task', description: '' }).id;
    tasks.updateTask(taskId, { status: 'in_progress' });
    const now = new Date().toISOString();
    const session: Session = {
      id: SESSION_ID,
      title: 'Worker',
      workspacePath: dir,
      createdAt: now,
      lastActiveAt: now,
      status: 'active',
      config: { model: 'fictional-model' },
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
      },
      type: 'worker',
      context: { spaceId: space.id, taskId },
    };
    await db.createSession(session);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a fenced main-thread write when a lane write issued before it lands first', async () => {
    await writeTask('updateTask', taskId, { status: 'blocked' });

    const reopened = tasks.updateTask(taskId, { status: 'open' }, 'in_progress');

    expect(reopened).toBeNull();
    expect(tasks.getTask(taskId)?.status).toBe('blocked');
  });

  it('lands a lane write after a fenced main-thread write that committed while it was queued', async () => {
    const queued = writeTask('updateTask', taskId, { title: 'Renamed' });
    const blocked = tasks.updateTask(taskId, { status: 'blocked' }, 'in_progress');

    await queued;
    expect(blocked?.status).toBe('blocked');
    expect(tasks.getTask(taskId)).toMatchObject({ status: 'blocked', title: 'Renamed' });
  });

  it('keeps a session write and the terminal-task archive cascade in issue order on the lane', async () => {
    const reactivate = db.updateSession(SESSION_ID, { status: 'paused' });
    const done = writeTask('updateTask', taskId, { status: 'done' });

    expect(await reactivate).toBe('written');
    expect((await done)?.status).toBe('done');
    expect(db.getSession(SESSION_ID)?.status).toBe('archived');
  });
});
