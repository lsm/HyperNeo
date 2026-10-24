import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@hyperneo/shared';
import { Database } from '../../../../src/storage';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';

const SESSION_ID = 'worker-session';

describe('session status writes racing the terminal-task archive cascade', () => {
  let dir: string;
  let db: Database;
  let tasks: SpaceTaskRepository;
  let taskId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hn-session-archive-race-'));
    db = new Database(join(dir, 'daemon.db'));
    await db.initialize(createReactiveDatabase(db));
    const raw = db.getDatabase();
    const space = new SpaceRepository(raw).createSpace({
      workspacePath: dir,
      slug: 'race',
      name: 'Race',
    });
    tasks = new SpaceTaskRepository(raw);
    taskId = tasks.createTask({ spaceId: space.id, title: 'Task', description: '' }).id;
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

  it('keeps the session archived when a status write issued before the cascade commits after it', async () => {
    const write = db.updateSession(SESSION_ID, { status: 'active', title: 'Late' });
    tasks.archiveTask(taskId);

    const outcome = await write;
    expect(db.getSession(SESSION_ID)).toMatchObject({ status: 'archived', title: 'Worker' });
    expect(outcome).toBe('stale-status');
  });

  it('archives the session when the status write commits before the cascade runs', async () => {
    const outcome = await db.updateSession(SESSION_ID, { status: 'paused' });
    tasks.archiveTask(taskId);

    expect(db.getSession(SESSION_ID)?.status).toBe('archived');
    expect(outcome).toBe('written');
  });

  it('refuses to reactivate the session of a terminal task after the cascade', async () => {
    tasks.archiveTask(taskId);

    const outcome = await db.updateSession(SESSION_ID, { status: 'active' });
    expect(db.getSession(SESSION_ID)?.status).toBe('archived');
    expect(outcome).toBe('terminal-task');
  });

  it('still lands a write that leaves status alone after the cascade', async () => {
    const write = db.updateSession(SESSION_ID, { title: 'Renamed' });
    tasks.archiveTask(taskId);

    const outcome = await write;
    expect(db.getSession(SESSION_ID)).toMatchObject({ status: 'archived', title: 'Renamed' });
    expect(outcome).toBe('written');
  });
});
