import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';

describe('SpaceTaskRepository — "approved" status + post-approval columns', () => {
  let db: Database;
  let repo: SpaceTaskRepository;
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    const spaceRepo = new SpaceRepository(db as any);
    repo = new SpaceTaskRepository(db as any);
    const space = spaceRepo.createSpace({
      workspacePath: '/workspace/post-approval',
      slug: 'post-approval',
      name: 'PA',
    });
    spaceId = space.id;
  });

  afterEach(() => {
    db.close();
  });

  test('updateTask accepts status="approved" and round-trips it', () => {
    const task = repo.createTask({ spaceId, title: 'T', description: '' });
    const updated = repo.updateTask(task.id, { status: 'approved' });
    expect(updated?.status).toBe('approved');

    const fetched = repo.getTask(task.id);
    expect(fetched?.status).toBe('approved');
  });

  test('moving into "approved" does not stamp completedAt (it is not a terminal status)', () => {
    const task = repo.createTask({ spaceId, title: 'T', description: '' });
    const updated = repo.updateTask(task.id, { status: 'approved' });
    expect(updated?.completedAt).toBeNull();
  });

  test('round-trips the three post_approval_* columns through updateTask', () => {
    const task = repo.createTask({ spaceId, title: 'T', description: '' });
    expect(task.postApprovalSessionId).toBeNull();
    expect(task.postApprovalStartedAt).toBeNull();
    expect(task.postApprovalBlockedReason).toBeNull();

    const ts = Date.now();
    const updated = repo.updateTask(task.id, {
      postApprovalSessionId: 'sess-abc',
      postApprovalStartedAt: ts,
      postApprovalBlockedReason: 'waiting on token',
    });
    expect(updated?.postApprovalSessionId).toBe('sess-abc');
    expect(updated?.postApprovalStartedAt).toBe(ts);
    expect(updated?.postApprovalBlockedReason).toBe('waiting on token');

    const fetched = repo.getTask(task.id);
    expect(fetched?.postApprovalSessionId).toBe('sess-abc');
    expect(fetched?.postApprovalStartedAt).toBe(ts);
    expect(fetched?.postApprovalBlockedReason).toBe('waiting on token');
  });

  test('post_approval_* columns can be cleared back to null', () => {
    const task = repo.createTask({ spaceId, title: 'T', description: '' });
    repo.updateTask(task.id, {
      postApprovalSessionId: 'sess-abc',
      postApprovalStartedAt: 123,
      postApprovalBlockedReason: 'r',
    });

    const cleared = repo.updateTask(task.id, {
      postApprovalSessionId: null,
      postApprovalStartedAt: null,
      postApprovalBlockedReason: null,
    });
    expect(cleared?.postApprovalSessionId).toBeNull();
    expect(cleared?.postApprovalStartedAt).toBeNull();
    expect(cleared?.postApprovalBlockedReason).toBeNull();
  });

  test('approved + post_approval columns survive a full save → load → assert round-trip', () => {
    const task = repo.createTask({ spaceId, title: 'Ship PR', description: '' });
    const ts = Date.now();
    repo.updateTask(task.id, {
      status: 'approved',
      postApprovalSessionId: 'sess-xyz',
      postApprovalStartedAt: ts,
      postApprovalBlockedReason: null,
    });

    const fetched = repo.getTask(task.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.status).toBe('approved');
    expect(fetched?.postApprovalSessionId).toBe('sess-xyz');
    expect(fetched?.postApprovalStartedAt).toBe(ts);
    expect(fetched?.postApprovalBlockedReason).toBeNull();
  });

  test('listByStatus(space, "approved") returns only approved tasks', () => {
    const a = repo.createTask({ spaceId, title: 'A', description: '' });
    const b = repo.createTask({ spaceId, title: 'B', description: '' });
    repo.updateTask(a.id, { status: 'approved' });
    repo.updateTask(b.id, { status: 'in_progress' });

    const approved = repo.listByStatus(spaceId, 'approved');
    expect(approved).toHaveLength(1);
    expect(approved[0].title).toBe('A');
  });
});
