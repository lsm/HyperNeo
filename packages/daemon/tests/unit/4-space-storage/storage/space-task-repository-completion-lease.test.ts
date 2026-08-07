/**
 * SpaceTaskRepository — post-approval completion progress + lease CAS (task #868).
 *
 * Covers the round-trip of the four migration-173 columns and the
 * compare-and-swap lease semantics that prevent concurrent completion from
 * duplicating work.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';
import type { PostApprovalProgress } from '@hyperneo/shared';

describe('SpaceTaskRepository — completion progress + lease', () => {
  let db: Database;
  let repo: SpaceTaskRepository;
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    const spaceRepo = new SpaceRepository(db as any);
    repo = new SpaceTaskRepository(db as any);
    spaceId = spaceRepo.createSpace({ workspacePath: '/ws', slug: 's', name: 'S' }).id;
  });
  afterEach(() => db.close());

  test('round-trips postApprovalProgress + completion status + lease fields', () => {
    const task = repo.createTask({ spaceId, title: 'T', description: '' });
    const progress: PostApprovalProgress = {
      checkpoints: { merge_confirmed: { status: 'done', at: 123 } },
      completionStatus: 'completion recovery',
      prUrl: 'https://github.com/o/r/pull/1',
      baseBranch: 'dev',
    };
    repo.updateTask(task.id, {
      status: 'approved',
      postApprovalProgress: progress,
      postApprovalCompletionStatus: 'completion recovery',
      postApprovalCompletionLeaseOwner: 'owner-A',
      postApprovalCompletionLeaseExpiresAt: 999,
    });

    const fetched = repo.getTask(task.id);
    expect(fetched?.postApprovalProgress?.checkpoints.merge_confirmed?.status).toBe('done');
    expect(fetched?.postApprovalProgress?.prUrl).toBe('https://github.com/o/r/pull/1');
    expect(fetched?.postApprovalCompletionStatus).toBe('completion recovery');
    expect(fetched?.postApprovalCompletionLeaseOwner).toBe('owner-A');
    expect(fetched?.postApprovalCompletionLeaseExpiresAt).toBe(999);
  });

  test('null progress / status / lease round-trip', () => {
    const task = repo.createTask({ spaceId, title: 'T', description: '' });
    expect(repo.getTask(task.id)?.postApprovalProgress).toBeNull();
    expect(repo.getTask(task.id)?.postApprovalCompletionStatus).toBeNull();
    expect(repo.getTask(task.id)?.postApprovalCompletionLeaseOwner).toBeNull();
  });

  test('claimPostApprovalCompletionLease: first claim wins, second is blocked', () => {
    const task = repo.createTask({ spaceId, title: 'T', description: '' });
    repo.updateTask(task.id, { status: 'approved' });

    const first = repo.claimPostApprovalCompletionLease(task.id, 'A', 1000, 5000);
    expect(first).toBe(true);
    const second = repo.claimPostApprovalCompletionLease(task.id, 'B', 2000, 5000);
    expect(second).toBe(false);

    const fetched = repo.getTask(task.id);
    expect(fetched?.postApprovalCompletionLeaseOwner).toBe('A');
    expect(fetched?.postApprovalCompletionLeaseExpiresAt).toBe(6000);
  });

  test('an expired lease can be re-claimed by another owner', () => {
    const task = repo.createTask({ spaceId, title: 'T', description: '' });
    repo.updateTask(task.id, { status: 'approved' });
    expect(repo.claimPostApprovalCompletionLease(task.id, 'A', 1000, 5000)).toBe(true);
    // now=7000 > expiry 6000 → lease has self-expired; B can claim.
    expect(repo.claimPostApprovalCompletionLease(task.id, 'B', 7000, 5000)).toBe(true);
    expect(repo.getTask(task.id)?.postApprovalCompletionLeaseOwner).toBe('B');
  });

  test('a lease cannot be claimed on a non-approved task', () => {
    const task = repo.createTask({ spaceId, title: 'T', description: '' });
    // status defaults to 'open' (not approved).
    expect(repo.claimPostApprovalCompletionLease(task.id, 'A', 1000, 5000)).toBe(false);
  });

  test('releasePostApprovalCompletionLease only releases when the owner matches', () => {
    const task = repo.createTask({ spaceId, title: 'T', description: '' });
    repo.updateTask(task.id, { status: 'approved' });
    repo.claimPostApprovalCompletionLease(task.id, 'A', 1000, 5000);

    // A different owner must not clobber the live lease.
    repo.releasePostApprovalCompletionLease(task.id, 'B');
    expect(repo.getTask(task.id)?.postApprovalCompletionLeaseOwner).toBe('A');

    // The actual owner releases.
    repo.releasePostApprovalCompletionLease(task.id, 'A');
    expect(repo.getTask(task.id)?.postApprovalCompletionLeaseOwner).toBeNull();
    // After release, a new claim succeeds.
    expect(repo.claimPostApprovalCompletionLease(task.id, 'C', 1000, 5000)).toBe(true);
  });

  test('listApprovedTasks returns approved tasks across spaces', () => {
    const other = new SpaceRepository(db as any).createSpace({
      workspacePath: '/ws2',
      slug: 's2',
      name: 'S2',
    });
    const a = repo.createTask({ spaceId, title: 'A', description: '' });
    const b = repo.createTask({ spaceId: other.id, title: 'B', description: '' });
    const c = repo.createTask({ spaceId, title: 'C', description: '' });
    repo.updateTask(a.id, { status: 'approved' });
    repo.updateTask(b.id, { status: 'approved' });
    repo.updateTask(c.id, { status: 'in_progress' });

    const approved = repo
      .listApprovedTasks()
      .map((t) => t.id)
      .sort();
    expect(approved).toEqual([a.id, b.id].sort());
  });

  test('updateTask CAS guard: terminal done write requires approved + lease owner', () => {
    const task = repo.createTask({ spaceId, title: 'T', description: '' });
    repo.updateTask(task.id, { status: 'approved' });
    repo.claimPostApprovalCompletionLease(task.id, 'owner-A', 1000, 5000);

    // Correct guard → write succeeds.
    const ok = repo.updateTask(
      task.id,
      { status: 'done', completedAt: 2000 },
      { status: 'approved', postApprovalCompletionLeaseOwner: 'owner-A' }
    );
    expect(ok?.status).toBe('done');

    // Reset for the miss case.
    const task2 = repo.createTask({ spaceId, title: 'T2', description: '' });
    repo.updateTask(task2.id, { status: 'approved' });
    repo.claimPostApprovalCompletionLease(task2.id, 'owner-A', 1000, 5000);
    // A concurrent cancel clears the lease + changes status BEFORE the terminal
    // write — the CAS guard must miss (return null, no overwrite).
    repo.updateTask(task2.id, {
      status: 'cancelled',
      postApprovalCompletionLeaseOwner: null,
      postApprovalCompletionLeaseExpiresAt: null,
    });
    const miss = repo.updateTask(
      task2.id,
      { status: 'done', completedAt: 2000 },
      { status: 'approved', postApprovalCompletionLeaseOwner: 'owner-A' }
    );
    expect(miss).toBeNull();
    // The cancel is NOT overwritten.
    expect(repo.getTask(task2.id)?.status).toBe('cancelled');
  });
});
