import { Database } from '../../../../src/storage/sqlite-compat';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  isValidSpaceTaskTransition,
  SpaceTaskManager,
  VALID_SPACE_TASK_TRANSITIONS,
} from '../../../../src/lib/space/managers/space-task-manager';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

describe('SpaceTaskManager', () => {
  let db: Database;
  let spaceRepo: SpaceRepository;
  let manager: SpaceTaskManager;
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    spaceRepo = new SpaceRepository(db as any);

    const space = spaceRepo.createSpace({
      workspacePath: '/workspace/test',
      slug: 'test',
      name: 'Test',
    });
    spaceId = space.id;
    manager = new SpaceTaskManager(
      db as any,
      spaceId,
      undefined,
      undefined,
      undefined,
      undefined,
      async (rawPath: string) => {
        if (rawPath === '/workspace/test' || rawPath === '/secondary') return rawPath;
        throw new Error(`Workspace path is not registered to space: ${rawPath}`);
      }
    );
  });

  afterEach(() => {
    db.close();
  });

  describe('isValidSpaceTaskTransition', () => {
    it('allows valid transitions', () => {
      expect(isValidSpaceTaskTransition('open', 'in_progress')).toBe(true);
      expect(isValidSpaceTaskTransition('in_progress', 'done')).toBe(true);
      expect(isValidSpaceTaskTransition('in_progress', 'blocked')).toBe(true);
      expect(isValidSpaceTaskTransition('done', 'in_progress')).toBe(true);
    });

    it('allows new manual transitions', () => {
      expect(isValidSpaceTaskTransition('open', 'blocked')).toBe(true);
      expect(isValidSpaceTaskTransition('open', 'done')).toBe(true);
      expect(isValidSpaceTaskTransition('in_progress', 'open')).toBe(true);
    });

    it('rejects invalid transitions', () => {
      expect(isValidSpaceTaskTransition('done', 'open')).toBe(false);
    });
  });

  describe('createTask', () => {
    it('creates a task with minimal params', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      expect(task.spaceId).toBe(spaceId);
      expect(task.title).toBe('T');
      expect(task.status).toBe('open');
    });

    it('creates a task with dependencies', async () => {
      const dep = await manager.createTask({ title: 'Dep', description: '' });
      const task = await manager.createTask({
        title: 'Child',
        description: '',
        dependsOn: [dep.id],
      });
      expect(task.dependsOn).toContain(dep.id);
    });

    it('throws when a dependency does not exist', async () => {
      await expect(
        manager.createTask({ title: 'T', description: '', dependsOn: ['nonexistent'] })
      ).rejects.toThrow('Dependency task not found');
    });
  });

  describe('getTask', () => {
    it('returns task belonging to this space', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      expect(await manager.getTask(task.id)).not.toBeNull();
    });

    it('returns null for task in another space', async () => {
      const otherSpace = spaceRepo.createSpace({
        workspacePath: '/workspace/other',
        slug: 'other-space',
        name: 'Other',
      });
      const otherManager = new SpaceTaskManager(db as any, otherSpace.id);
      const otherTask = await otherManager.createTask({ title: 'T', description: '' });

      expect(await manager.getTask(otherTask.id)).toBeNull();
    });
  });

  describe('setTaskStatus', () => {
    it('transitions open -> in_progress', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      const updated = await manager.setTaskStatus(task.id, 'in_progress');
      expect(updated.status).toBe('in_progress');
    });

    it('clears stale outcome fields when a stopped task is reopened', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.setTaskStatus(task.id, 'stopped');
      await manager.updateTask(task.id, {
        reportedStatus: 'done',
        reportedSummary: 'stale summary',
        result: 'stale result',
        blockReason: 'stale reason',
      });

      const reopened = await manager.setTaskStatus(task.id, 'open');

      expect(reopened.status).toBe('open');
      expect(reopened.reportedStatus).toBeNull();
      expect(reopened.reportedSummary).toBeNull();
      expect(reopened.result).toBeNull();
      expect(reopened.blockReason).toBeNull();

      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.setTaskStatus(task.id, 'stopped');
      await manager.updateTask(task.id, {
        reportedStatus: 'done',
        reportedSummary: 'stale summary',
        result: 'stale result',
        blockReason: 'stale reason',
      });

      const resumed = await manager.setTaskStatus(task.id, 'in_progress');

      expect(resumed.status).toBe('in_progress');
      expect(resumed.reportedStatus).toBeNull();
      expect(resumed.reportedSummary).toBeNull();
      expect(resumed.result).toBeNull();
      expect(resumed.blockReason).toBeNull();
    });

    it('transitions in_progress -> done with result', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      const done = await manager.setTaskStatus(task.id, 'done', { result: 'Done!' });
      expect(done.status).toBe('done');
      expect(done.result).toBe('Done!');
    });

    it('transitions open -> done (already completed)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      const done = await manager.setTaskStatus(task.id, 'done', { result: 'Already done' });
      expect(done.status).toBe('done');
      expect(done.result).toBe('Already done');
    });

    it('backfills result from reportedSummary when transitioning to done without explicit result', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.updateTask(task.id, { reportedSummary: 'Work completed via agent report' });
      const done = await manager.setTaskStatus(task.id, 'done');
      expect(done.status).toBe('done');
      expect(done.result).toBe('Work completed via agent report');
    });

    it('does not overwrite existing result with reportedSummary on done transition', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.updateTask(task.id, {
        result: 'PR #42 merged',
        reportedSummary: 'Agent reported completion',
      });
      const done = await manager.setTaskStatus(task.id, 'done');
      expect(done.status).toBe('done');
      expect(done.result).toBe('PR #42 merged');
    });

    it('backfills result from reportedSummary when transitioning to blocked without explicit result', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.updateTask(task.id, { reportedSummary: 'Blocked waiting for dependency' });
      const blocked = await manager.setTaskStatus(task.id, 'blocked');
      expect(blocked.status).toBe('blocked');
      expect(blocked.result).toBe('Blocked waiting for dependency');
    });

    it('backfills result from incoming reportedSummary when existing reportedSummary is null', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      const done = await manager.setTaskStatus(task.id, 'done', {
        reportedSummary: 'Completed via incoming summary',
      });
      expect(done.status).toBe('done');
      expect(done.result).toBe('Completed via incoming summary');
      expect(done.reportedSummary).toBe('Completed via incoming summary');
    });

    it('does not backfill result when reportedSummary is explicitly null', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.updateTask(task.id, { reportedSummary: 'Stale summary' });
      const done = await manager.setTaskStatus(task.id, 'done', {
        reportedSummary: null,
      });
      expect(done.status).toBe('done');
      expect(done.result).toBeNull();
      expect(done.reportedSummary).toBeNull();
    });

    it('does not backfill result when result is explicitly null', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.updateTask(task.id, { reportedSummary: 'Stale summary' });
      const done = await manager.setTaskStatus(task.id, 'done', {
        result: null,
      });
      expect(done.status).toBe('done');
      expect(done.result).toBeNull();
    });

    it('clears reportedSummary on review → in_progress (human rejection)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.submitTaskForReview(task.id, {
        submittedByNodeId: null,
        reason: 'ready',
      });
      await manager.updateTask(task.id, { reportedSummary: 'Old review summary' });
      const reopened = await manager.setTaskStatus(task.id, 'in_progress');
      expect(reopened.status).toBe('in_progress');
      expect(reopened.reportedSummary).toBeNull();
      expect(reopened.result).toBeNull();
    });

    it('transitions open -> blocked (blocker found before start)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      const blocked = await manager.setTaskStatus(task.id, 'blocked', {
        result: 'Missing dependency',
      });
      expect(blocked.status).toBe('blocked');
      expect(blocked.result).toBe('Missing dependency');
    });

    it('transitions in_progress -> open (pause/deprioritize)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      const paused = await manager.setTaskStatus(task.id, 'open');
      expect(paused.status).toBe('open');
      expect(paused.result).toBeNull();
    });

    it('throws for invalid transition', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await expect(manager.setTaskStatus(task.id, 'approved')).rejects.toThrow(
        'Invalid status transition'
      );
    });

    it('clears result when restarting from blocked', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.setTaskStatus(task.id, 'blocked');

      const restarted = await manager.setTaskStatus(task.id, 'open');
      expect(restarted.result).toBeNull();
    });

    it('clears result when restarting from cancelled -> open', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.setTaskStatus(task.id, 'blocked');
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.cancelTask(task.id);

      const restarted = await manager.setTaskStatus(task.id, 'open');
      expect(restarted.status).toBe('open');
      expect(restarted.result).toBeNull();
    });

    it('clears fields when restarting from cancelled -> in_progress', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.cancelTask(task.id);

      const restarted = await manager.setTaskStatus(task.id, 'in_progress');
      expect(restarted.status).toBe('in_progress');
      expect(restarted.error).toBeUndefined();
    });

    it('throws for unknown task', async () => {
      await expect(manager.setTaskStatus('nonexistent', 'in_progress')).rejects.toThrow(
        'not found'
      );
    });
  });

  describe('startTask / completeTask / failTask', () => {
    it('starts a task', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      const started = await manager.startTask(task.id);
      expect(started.status).toBe('in_progress');
    });

    it('completes a task', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      const done = await manager.completeTask(task.id, 'All done');
      expect(done.status).toBe('done');
    });

    it('fails a task (marks as blocked)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      const failed = await manager.failTask(task.id, 'Something went wrong');
      expect(failed.status).toBe('blocked');
    });

    it('persists result when failing a task with an error message', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      const failed = await manager.failTask(task.id, 'Dependency unavailable');
      expect(failed.status).toBe('blocked');
      expect(failed.result).toBe('Dependency unavailable');
    });

    it('persists result when transitioning to blocked via setTaskStatus', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      const blocked = await manager.setTaskStatus(task.id, 'blocked', {
        result: 'Waiting for approval',
      });
      expect(blocked.status).toBe('blocked');
      expect(blocked.result).toBe('Waiting for approval');
    });

    it('clears result when unblocking a task back to in_progress', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.setTaskStatus(task.id, 'blocked', { result: 'Some reason' });
      const restarted = await manager.setTaskStatus(task.id, 'in_progress');
      expect(restarted.status).toBe('in_progress');
      expect(restarted.result).toBeNull();
    });

    it('failTask without error message does not set result', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      const failed = await manager.failTask(task.id);
      expect(failed.status).toBe('blocked');
      expect(failed.result).toBeNull();
    });

    it('failTask stamps blockReason when provided', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      const failed = await manager.failTask(task.id, 'crash msg', 'agent_crashed');
      expect(failed.blockReason).toBe('agent_crashed');
    });

    it('failTask without blockReason sets it to null', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      const failed = await manager.failTask(task.id);
      expect(failed.blockReason).toBeNull();
    });

    it('setTaskStatus stamps blockReason when transitioning to blocked', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      const blocked = await manager.setTaskStatus(task.id, 'blocked', {
        result: 'Needs human input',
        blockReason: 'human_input_requested',
      });
      expect(blocked.blockReason).toBe('human_input_requested');
    });

    it('blockReason is cleared when reactivating from blocked to in_progress', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.failTask(task.id, 'crash', 'agent_crashed');
      const reactivated = await manager.setTaskStatus(task.id, 'in_progress');
      expect(reactivated.blockReason).toBeNull();
    });

    it('blockReason is cleared when reactivating from blocked to open', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.failTask(task.id, 'invalid', 'workflow_invalid');
      const restarted = await manager.setTaskStatus(task.id, 'open');
      expect(restarted.blockReason).toBeNull();
    });
  });

  describe('cancelTask', () => {
    it('cancels a task and cascades to open dependents', async () => {
      const t1 = await manager.createTask({ title: 'T1', description: '' });
      const t2 = await manager.createTask({
        title: 'T2',
        description: '',
        dependsOn: [t1.id],
      });

      await manager.cancelTask(t1.id);

      expect((await manager.getTask(t1.id))!.status).toBe('cancelled');
      expect((await manager.getTask(t2.id))!.status).toBe('cancelled');
    });

    it('cascades cancel to a rate/usage-limited dependent (not just open/in_progress)', async () => {
      const t1 = await manager.createTask({ title: 'T1', description: '' });
      const t2 = await manager.createTask({
        title: 'T2',
        description: '',
        dependsOn: [t1.id],
      });
      await manager.setTaskStatus(t2.id, 'in_progress');
      db.prepare(`UPDATE space_tasks SET status = 'usage_limited' WHERE id = ?`).run(t2.id);
      db.prepare(`UPDATE space_tasks SET status = 'cancelled' WHERE id = ?`).run(t1.id);

      await manager.cancelDependentTasks(t1.id);

      expect((await manager.getTask(t2.id))!.status).toBe('cancelled');
    });
  });

  describe('blockDependentTasks cascade', () => {
    it('blocks a rate/usage-limited dependent when its prerequisite fails', async () => {
      const t1 = await manager.createTask({ title: 'T1', description: '' });
      const t2 = await manager.createTask({
        title: 'T2',
        description: '',
        dependsOn: [t1.id],
      });
      await manager.setTaskStatus(t1.id, 'in_progress');
      await manager.setTaskStatus(t2.id, 'in_progress');
      db.prepare(`UPDATE space_tasks SET status = 'rate_limited' WHERE id = ?`).run(t2.id);

      await manager.blockDependentTasks(t1.id);

      const t2after = await manager.getTask(t2.id);
      expect(t2after!.status).toBe('blocked');
      expect(t2after!.blockReason).toBe('dependency_failed');
    });
  });

  describe('archiveTask', () => {
    it('archives a done task and sets both status and archivedAt', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.setTaskStatus(task.id, 'done');
      const archived = await manager.archiveTask(task.id);
      expect(archived.status).toBe('archived');
      expect(archived.archivedAt).toBeDefined();
      expect(typeof archived.archivedAt).toBe('number');
    });

    it('archives a cancelled task and sets both status and archivedAt', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.cancelTask(task.id);
      const archived = await manager.archiveTask(task.id);
      expect(archived.status).toBe('archived');
      expect(archived.archivedAt).toBeDefined();
      expect(typeof archived.archivedAt).toBe('number');
    });

    it('archives a blocked task and sets both status and archivedAt', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.setTaskStatus(task.id, 'blocked');
      const archived = await manager.archiveTask(task.id);
      expect(archived.status).toBe('archived');
      expect(archived.archivedAt).toBeDefined();
      expect(typeof archived.archivedAt).toBe('number');
    });

    it('archives a task in open status and sets both status and archivedAt', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      expect(task.status).toBe('open');
      const archived = await manager.archiveTask(task.id);
      expect(archived.status).toBe('archived');
      expect(archived.archivedAt).toBeDefined();
      expect(typeof archived.archivedAt).toBe('number');
    });

    it('throws when archiving a task in in_progress status', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await expect(manager.archiveTask(task.id)).rejects.toThrow(
        "Invalid status transition from 'in_progress' to 'archived'"
      );
    });
  });

  describe('deleteTask', () => {
    it('deletes a task', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      expect(await manager.deleteTask(task.id)).toBe(true);
      expect(await manager.getTask(task.id)).toBeNull();
    });

    it('returns false for unknown task', async () => {
      expect(await manager.deleteTask('nonexistent')).toBe(false);
    });
  });

  describe('areDependenciesMet', () => {
    it('returns true when no dependencies', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      expect(await manager.areDependenciesMet(task)).toBe(true);
    });

    it('returns false when dependency is not done', async () => {
      const dep = await manager.createTask({ title: 'Dep', description: '' });
      const task = await manager.createTask({
        title: 'Child',
        description: '',
        dependsOn: [dep.id],
      });
      expect(await manager.areDependenciesMet(task)).toBe(false);
    });

    it('returns true when all dependencies are done', async () => {
      const dep = await manager.createTask({ title: 'Dep', description: '' });
      await manager.startTask(dep.id);
      await manager.completeTask(dep.id, 'done');

      const task = await manager.createTask({
        title: 'Child',
        description: '',
        dependsOn: [dep.id],
      });
      expect(await manager.areDependenciesMet(task)).toBe(true);
    });
  });

  describe('retryTask', () => {
    it('retries a blocked task -> open', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.failTask(task.id, 'Something went wrong');

      const retried = await manager.retryTask(task.id);
      expect(retried.status).toBe('open');
      expect(retried.result).toBeNull();
    });

    it('retries a cancelled task -> in_progress (reactivation)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.cancelTask(task.id);

      const retried = await manager.retryTask(task.id);
      expect(retried.status).toBe('in_progress');
      expect(retried.error).toBeUndefined();
    });

    it('retries a done task -> in_progress (reactivation)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.completeTask(task.id, 'done');

      const retried = await manager.retryTask(task.id);
      expect(retried.status).toBe('in_progress');
    });

    it('clears stale result when retrying a done task', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.completeTask(task.id, 'previous result');

      const completed = await manager.getTask(task.id);
      expect(completed!.result).toBe('previous result');

      const retried = await manager.retryTask(task.id);
      expect(retried.status).toBe('in_progress');
      expect(retried.result).toBeNull();
    });

    it('updates description when provided', async () => {
      const task = await manager.createTask({ title: 'T', description: 'original' });
      await manager.startTask(task.id);
      await manager.failTask(task.id, 'error');

      const retried = await manager.retryTask(task.id, { description: 'updated description' });
      expect(retried.status).toBe('open');
      expect(retried.description).toBe('updated description');
    });

    it('throws when task is in_progress', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);

      await expect(manager.retryTask(task.id)).rejects.toThrow(
        "Cannot retry task in 'in_progress'"
      );
    });

    it('throws when task is open', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });

      await expect(manager.retryTask(task.id)).rejects.toThrow("Cannot retry task in 'open'");
    });

    it('throws for unknown task', async () => {
      await expect(manager.retryTask('nonexistent')).rejects.toThrow('Task not found');
    });
  });

  describe('reassignTask', () => {
    it('reassigns a task from open status', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });

      const reassigned = await manager.reassignTask(task.id, 'custom-agent-123');
      expect(reassigned.id).toBe(task.id);
    });

    it('reassigns a blocked task', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.failTask(task.id, 'error');

      const reassigned = await manager.reassignTask(task.id, 'new-agent', 'coder');
      expect(reassigned.status).toBe('blocked');
    });

    it('reassigns a cancelled task', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.cancelTask(task.id);

      const reassigned = await manager.reassignTask(task.id, 'another-agent');
      expect(reassigned.status).toBe('cancelled');
    });

    it('throws when task is in_progress', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);

      await expect(manager.reassignTask(task.id, 'new-agent')).rejects.toThrow(
        "Cannot reassign task in 'in_progress'"
      );
    });

    it('reassigns a done task', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.completeTask(task.id, 'done');

      const reassigned = await manager.reassignTask(task.id, 'new-agent');
      expect(reassigned.status).toBe('done');
    });

    it('throws when task is archived', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.completeTask(task.id, 'done');
      await manager.archiveTask(task.id);

      await expect(manager.reassignTask(task.id, 'new-agent')).rejects.toThrow(
        "Cannot reassign task in 'archived'"
      );
    });

    it('throws for unknown task', async () => {
      await expect(manager.reassignTask('nonexistent', 'agent-id')).rejects.toThrow(
        'Task not found'
      );
    });
  });

  describe('completion does not prevent reactivation', () => {
    it('done task can be reactivated to in_progress', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.completeTask(task.id, 'done');

      const completed = await manager.getTask(task.id);
      expect(completed!.status).toBe('done');
      expect(completed!.result).toBe('done');

      const reactivated = await manager.setTaskStatus(task.id, 'in_progress');
      expect(reactivated.status).toBe('in_progress');
      expect(reactivated.result).toBeNull();
    });

    it('cancelled task can be reactivated to in_progress', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.cancelTask(task.id);

      const reactivated = await manager.setTaskStatus(task.id, 'in_progress');
      expect(reactivated.status).toBe('in_progress');
      expect(reactivated.error).toBeUndefined();
    });

    it('done task can be retried via retryTask()', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.completeTask(task.id, 'previous result');

      const retried = await manager.retryTask(task.id);
      expect(retried.status).toBe('in_progress');
      expect(retried.result).toBeNull();
    });
  });

  describe('VALID_SPACE_TASK_TRANSITIONS', () => {
    it('done allows reactivation and archival', () => {
      expect(VALID_SPACE_TASK_TRANSITIONS.done).toEqual(['in_progress', 'archived']);
    });

    it('cancelled allows restart, reactivation, done, and archival', () => {
      expect(VALID_SPACE_TASK_TRANSITIONS.cancelled).toEqual([
        'open',
        'in_progress',
        'done',
        'archived',
      ]);
    });

    it('blocked allows restart, review, completion, cancellation, archival, and stopping', () => {
      expect(VALID_SPACE_TASK_TRANSITIONS.blocked).toEqual([
        'open',
        'in_progress',
        'review',
        'done',
        'cancelled',
        'archived',
        'stopped',
      ]);
    });

    it('archived is a true terminal state with no transitions', () => {
      expect(VALID_SPACE_TASK_TRANSITIONS.archived).toEqual([]);
    });

    it('open allows in_progress, blocked, review, done, cancelled, and archived', () => {
      expect(VALID_SPACE_TASK_TRANSITIONS.open).toEqual([
        'in_progress',
        'blocked',
        'review',
        'done',
        'cancelled',
        'archived',
      ]);
    });

    it('in_progress allows open, review, approved, done, blocked, cancelled, stopped, and the runtime-owned limited statuses', () => {
      expect(VALID_SPACE_TASK_TRANSITIONS.in_progress).toEqual([
        'open',
        'review',
        'approved',
        'done',
        'blocked',
        'cancelled',
        'stopped',
        'rate_limited',
        'usage_limited',
      ]);
    });
  });

  describe('archived status transitions', () => {
    it('transitions done -> archived', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.setTaskStatus(task.id, 'done', { result: 'done' });
      const archived = await manager.setTaskStatus(task.id, 'archived');
      expect(archived.status).toBe('archived');
    });

    it('transitions cancelled -> archived', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.cancelTask(task.id);
      const archived = await manager.setTaskStatus(task.id, 'archived');
      expect(archived.status).toBe('archived');
    });

    it('transitions cancelled -> done (e.g. PR merged after cancellation)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.cancelTask(task.id);
      const done = await manager.setTaskStatus(task.id, 'done');
      expect(done.status).toBe('done');
    });

    it('transitions blocked -> archived', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.setTaskStatus(task.id, 'blocked');
      const archived = await manager.setTaskStatus(task.id, 'archived');
      expect(archived.status).toBe('archived');
    });

    it('rejects transition from archived to any status', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.setTaskStatus(task.id, 'done');
      await manager.setTaskStatus(task.id, 'archived');

      await expect(manager.setTaskStatus(task.id, 'in_progress')).rejects.toThrow(
        'Invalid status transition'
      );
      await expect(manager.setTaskStatus(task.id, 'open')).rejects.toThrow(
        'Invalid status transition'
      );
    });

    it('allows transition from open -> archived (G1)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      const archived = await manager.setTaskStatus(task.id, 'archived');
      expect(archived.status).toBe('archived');
    });

    it('rejects transition from in_progress -> archived', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await expect(manager.setTaskStatus(task.id, 'archived')).rejects.toThrow(
        'Invalid status transition'
      );
    });

    it('rejects archived -> every status (exhaustive)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.setTaskStatus(task.id, 'done');
      await manager.setTaskStatus(task.id, 'archived');

      const allStatuses = [
        'open',
        'in_progress',
        'review',
        'done',
        'blocked',
        'cancelled',
        'archived',
      ] as const;
      for (const status of allStatuses) {
        await expect(manager.setTaskStatus(task.id, status)).rejects.toThrow(
          'Invalid status transition'
        );
      }
    });

    it('allows cancelled -> open transition (restart)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.cancelTask(task.id);
      const restarted = await manager.setTaskStatus(task.id, 'open');
      expect(restarted.status).toBe('open');
    });

    it('allows cancelled -> in_progress transition (reactivation)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.cancelTask(task.id);
      const reactivated = await manager.setTaskStatus(task.id, 'in_progress');
      expect(reactivated.status).toBe('in_progress');
    });

    it('allows done -> in_progress transition (reactivation)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.setTaskStatus(task.id, 'done', { result: 'done' });
      const reactivated = await manager.setTaskStatus(task.id, 'in_progress');
      expect(reactivated.status).toBe('in_progress');
    });

    it('allows blocked -> open transition (restart)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.setTaskStatus(task.id, 'in_progress');
      await manager.setTaskStatus(task.id, 'blocked');
      const restarted = await manager.setTaskStatus(task.id, 'open');
      expect(restarted.status).toBe('open');
    });
  });

  describe('retryTask — archived rejection', () => {
    it('throws when retrying an archived task', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.completeTask(task.id, 'done');
      await manager.archiveTask(task.id);

      await expect(manager.retryTask(task.id)).rejects.toThrow("Cannot retry task in 'archived'");
    });
  });

  describe('cycle detection', () => {
    it('rejects self-dependency on create', async () => {
      const t = await manager.createTask({ title: 'T', description: '' });
      await expect(manager.updateTask(t.id, { dependsOn: [t.id] })).rejects.toThrow(
        'cannot depend on itself'
      );
    });

    it('rejects circular dependency A→B→A on update', async () => {
      const a = await manager.createTask({ title: 'A', description: '' });
      const b = await manager.createTask({ title: 'B', description: '', dependsOn: [a.id] });

      await expect(manager.updateTask(a.id, { dependsOn: [b.id] })).rejects.toThrow(
        'circular dependency'
      );
    });

    it('rejects transitive cycle A→B→C→A', async () => {
      const a = await manager.createTask({ title: 'A', description: '' });
      const b = await manager.createTask({ title: 'B', description: '', dependsOn: [a.id] });
      const c = await manager.createTask({ title: 'C', description: '', dependsOn: [b.id] });

      await expect(manager.updateTask(a.id, { dependsOn: [c.id] })).rejects.toThrow(
        'circular dependency'
      );
    });

    it('allows valid DAG (diamond shape)', async () => {
      const a = await manager.createTask({ title: 'A', description: '' });
      const b = await manager.createTask({ title: 'B', description: '', dependsOn: [a.id] });
      const c = await manager.createTask({ title: 'C', description: '', dependsOn: [a.id] });
      const d = await manager.createTask({
        title: 'D',
        description: '',
        dependsOn: [b.id, c.id],
      });
      expect(d.dependsOn).toEqual([b.id, c.id]);
    });
  });

  describe('dependency validation on update', () => {
    it('validates dependency IDs exist when updating dependsOn', async () => {
      const t = await manager.createTask({ title: 'T', description: '' });
      await expect(manager.updateTask(t.id, { dependsOn: ['nonexistent'] })).rejects.toThrow(
        'Dependency task not found'
      );
    });

    it('allows updating dependsOn with valid IDs', async () => {
      const dep = await manager.createTask({ title: 'Dep', description: '' });
      const t = await manager.createTask({ title: 'T', description: '' });
      const updated = await manager.updateTask(t.id, { dependsOn: [dep.id] });
      expect(updated.dependsOn).toContain(dep.id);
    });

    it('allows clearing dependsOn', async () => {
      const dep = await manager.createTask({ title: 'Dep', description: '' });
      const t = await manager.createTask({
        title: 'T',
        description: '',
        dependsOn: [dep.id],
      });
      const updated = await manager.updateTask(t.id, { dependsOn: [] });
      expect(updated.dependsOn).toEqual([]);
    });
  });

  describe('blockDependentTasks (failure cascade)', () => {
    it('blocks in_progress tasks that depend on the failed task', async () => {
      const a = await manager.createTask({ title: 'A', description: '' });
      const b = await manager.createTask({ title: 'B', description: '', dependsOn: [a.id] });

      await manager.startTask(a.id);
      await manager.startTask(b.id);
      await manager.failTask(a.id, 'crashed', 'agent_crashed');

      const cascaded = await manager.blockDependentTasks(a.id);
      expect(cascaded).toHaveLength(1);
      expect(cascaded[0].id).toBe(b.id);
      expect(cascaded[0].status).toBe('blocked');
      expect(cascaded[0].blockReason).toBe('dependency_failed');
    });

    it('does NOT block open tasks waiting on the failed dependency', async () => {
      const a = await manager.createTask({ title: 'A', description: '' });
      const b = await manager.createTask({ title: 'B', description: '', dependsOn: [a.id] });

      await manager.startTask(a.id);
      await manager.failTask(a.id, 'crashed', 'agent_crashed');

      const cascaded = await manager.blockDependentTasks(a.id);
      expect(cascaded).toHaveLength(0);
      const bAfter = (await manager.getTask(b.id))!;
      expect(bAfter.status).toBe('open');
      expect(bAfter.blockReason ?? null).toBeNull();
    });

    it('cascades recursively through in_progress dependency chain', async () => {
      const a = await manager.createTask({ title: 'A', description: '' });
      const b = await manager.createTask({ title: 'B', description: '', dependsOn: [a.id] });
      const c = await manager.createTask({ title: 'C', description: '', dependsOn: [b.id] });

      await manager.startTask(a.id);
      await manager.startTask(b.id);
      await manager.startTask(c.id);
      await manager.failTask(a.id, 'crashed');

      const cascaded = await manager.blockDependentTasks(a.id);
      expect(cascaded).toHaveLength(2);

      const bBlocked = (await manager.getTask(b.id))!;
      const cBlocked = (await manager.getTask(c.id))!;
      expect(bBlocked.status).toBe('blocked');
      expect(bBlocked.blockReason).toBe('dependency_failed');
      expect(cBlocked.status).toBe('blocked');
      expect(cBlocked.blockReason).toBe('dependency_failed');
    });

    it('does not cascade to open or done tasks', async () => {
      const a = await manager.createTask({ title: 'A', description: '' });
      const b = await manager.createTask({ title: 'B', description: '', dependsOn: [a.id] });
      const c = await manager.createTask({ title: 'C', description: '', dependsOn: [a.id] });

      await manager.startTask(c.id);
      await manager.completeTask(c.id, 'done');

      await manager.startTask(a.id);
      await manager.failTask(a.id, 'crashed');

      const cascaded = await manager.blockDependentTasks(a.id);
      expect(cascaded).toHaveLength(0);
      expect((await manager.getTask(b.id))!.status).toBe('open');
      expect((await manager.getTask(c.id))!.status).toBe('done');
    });

    it('does not double-block in diamond dependency graph', async () => {
      const a = await manager.createTask({ title: 'A', description: '' });
      const b = await manager.createTask({ title: 'B', description: '', dependsOn: [a.id] });
      const d = await manager.createTask({
        title: 'D',
        description: '',
        dependsOn: [a.id, b.id],
      });

      await manager.startTask(a.id);
      await manager.startTask(b.id);
      await manager.startTask(d.id);
      await manager.failTask(a.id, 'crashed');

      const cascaded = await manager.blockDependentTasks(a.id);
      expect(cascaded.map((t) => t.id)).toContain(b.id);
      expect(cascaded.map((t) => t.id)).toContain(d.id);
      expect((await manager.getTask(d.id))!.status).toBe('blocked');
    });

    it('returns empty array when no dependents exist', async () => {
      const a = await manager.createTask({ title: 'A', description: '' });
      const cascaded = await manager.blockDependentTasks(a.id);
      expect(cascaded).toHaveLength(0);
    });
  });

  describe('cancelDependentTasks (cancellation cascade)', () => {
    it('cancels both open and in_progress dependents when parent is cancelled', async () => {
      const a = await manager.createTask({ title: 'A', description: '' });
      const bOpen = await manager.createTask({
        title: 'B',
        description: '',
        dependsOn: [a.id],
      });
      const cInProgress = await manager.createTask({
        title: 'C',
        description: '',
        dependsOn: [a.id],
      });
      await manager.startTask(cInProgress.id);

      await manager.startTask(a.id);
      await manager.setTaskStatus(a.id, 'cancelled');

      const cascaded = await manager.cancelDependentTasks(a.id);
      const ids = cascaded.map((t) => t.id).sort();
      expect(ids).toEqual([bOpen.id, cInProgress.id].sort());

      expect((await manager.getTask(bOpen.id))!.status).toBe('cancelled');
      expect((await manager.getTask(cInProgress.id))!.status).toBe('cancelled');
    });

    it('cascades recursively through dependency chain', async () => {
      const a = await manager.createTask({ title: 'A', description: '' });
      const b = await manager.createTask({ title: 'B', description: '', dependsOn: [a.id] });
      const c = await manager.createTask({ title: 'C', description: '', dependsOn: [b.id] });

      await manager.startTask(a.id);
      await manager.setTaskStatus(a.id, 'cancelled');

      const cascaded = await manager.cancelDependentTasks(a.id);
      expect(cascaded).toHaveLength(2);
      expect((await manager.getTask(b.id))!.status).toBe('cancelled');
      expect((await manager.getTask(c.id))!.status).toBe('cancelled');
    });

    it('does not cascade to done tasks', async () => {
      const a = await manager.createTask({ title: 'A', description: '' });
      const done = await manager.createTask({
        title: 'Done',
        description: '',
        dependsOn: [a.id],
      });
      await manager.startTask(done.id);
      await manager.completeTask(done.id, 'finished');

      await manager.startTask(a.id);
      await manager.setTaskStatus(a.id, 'cancelled');

      const cascaded = await manager.cancelDependentTasks(a.id);
      expect(cascaded).toHaveLength(0);
      expect((await manager.getTask(done.id))!.status).toBe('done');
    });

    it('traverses through already-cancelled intermediates to reach open descendants', async () => {
      const a = await manager.createTask({ title: 'A', description: '' });
      const b = await manager.createTask({ title: 'B', description: '', dependsOn: [a.id] });
      const c = await manager.createTask({ title: 'C', description: '', dependsOn: [b.id] });

      await manager.startTask(b.id);
      await manager.setTaskStatus(b.id, 'cancelled');

      await manager.startTask(a.id);
      await manager.setTaskStatus(a.id, 'cancelled');

      const cascaded = await manager.cancelDependentTasks(a.id);
      expect(cascaded.map((t) => t.id)).toContain(c.id);
      expect((await manager.getTask(c.id))!.status).toBe('cancelled');
      expect((await manager.getTask(b.id))!.status).toBe('cancelled');
    });

    it('does not cascade through done/review/approved/blocked intermediates', async () => {
      const a = await manager.createTask({ title: 'A', description: '' });
      const bDone = await manager.createTask({
        title: 'B-done',
        description: '',
        dependsOn: [a.id],
      });
      const cOpen = await manager.createTask({
        title: 'C-open',
        description: '',
        dependsOn: [bDone.id],
      });

      await manager.startTask(bDone.id);
      await manager.completeTask(bDone.id, 'ok');

      await manager.startTask(a.id);
      await manager.setTaskStatus(a.id, 'cancelled');

      const cascaded = await manager.cancelDependentTasks(a.id);
      expect(cascaded).toHaveLength(0);
      expect((await manager.getTask(bDone.id))!.status).toBe('done');
      expect((await manager.getTask(cOpen.id))!.status).toBe('open');
    });

    it('does not cascade through a blocked intermediate', async () => {
      const a = await manager.createTask({ title: 'A', description: '' });
      const bBlocked = await manager.createTask({
        title: 'B-blocked',
        description: '',
        dependsOn: [a.id],
      });
      const cOpen = await manager.createTask({
        title: 'C-open',
        description: '',
        dependsOn: [bBlocked.id],
      });

      await manager.startTask(bBlocked.id);
      await manager.failTask(bBlocked.id, 'transient');

      await manager.startTask(a.id);
      await manager.setTaskStatus(a.id, 'cancelled');

      const cascaded = await manager.cancelDependentTasks(a.id);
      expect(cascaded).toHaveLength(0);
      expect((await manager.getTask(bBlocked.id))!.status).toBe('blocked');
      expect((await manager.getTask(cOpen.id))!.status).toBe('open');
    });

    it('returns empty array when no dependents exist', async () => {
      const a = await manager.createTask({ title: 'A', description: '' });
      const cascaded = await manager.cancelDependentTasks(a.id);
      expect(cascaded).toHaveLength(0);
    });
  });

  describe('taskNumber (numeric task IDs)', () => {
    it('createTask assigns auto-incrementing taskNumber', async () => {
      const t1 = await manager.createTask({ title: 'A', description: '' });
      const t2 = await manager.createTask({ title: 'B', description: '' });
      expect(t1.taskNumber).toBe(1);
      expect(t2.taskNumber).toBe(2);
    });

    it('getTaskByNumber retrieves the correct task', async () => {
      const t1 = await manager.createTask({ title: 'A', description: '' });
      await manager.createTask({ title: 'B', description: '' });

      const found = await manager.getTaskByNumber(1);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(t1.id);
      expect(found!.taskNumber).toBe(1);
    });

    it('getTaskByNumber returns null for non-existent number', async () => {
      await manager.createTask({ title: 'A', description: '' });
      expect(await manager.getTaskByNumber(999)).toBeNull();
    });

    it('getTaskByNumber is scoped to this space', async () => {
      await manager.createTask({ title: 'A', description: '' });

      const otherSpace = spaceRepo.createSpace({
        workspacePath: '/workspace/other',
        slug: 'other-scoped',
        name: 'Other',
      });
      const otherManager = new SpaceTaskManager(db as any, otherSpace.id);
      expect(await otherManager.getTaskByNumber(1)).toBeNull();
    });

    it('concurrent createTask assigns unique taskNumbers', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          manager.createTask({ title: `Concurrent ${i}`, description: '' })
        )
      );

      const numbers = results.map((t) => t.taskNumber);
      const uniqueNumbers = new Set(numbers);
      expect(uniqueNumbers.size).toBe(20);
      expect(Math.min(...numbers)).toBe(1);
      expect(Math.max(...numbers)).toBe(20);
    });
  });

  describe('submitTaskForReview', () => {
    it('transitions in_progress→review and stamps pending-completion fields atomically', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);

      const reviewing = await manager.submitTaskForReview(task.id, {
        submittedByNodeId: 'node-A',
        reason: 'ready for human review',
      });

      expect(reviewing.status).toBe('review');
      expect(reviewing.pendingCheckpointType).toBe('task_completion');
      expect(reviewing.pendingCompletionSubmittedByNodeId).toBe('node-A');
      expect(reviewing.pendingCompletionReason).toBe('ready for human review');
      expect(reviewing.postApprovalSourceNodeId).toBe('node-A');
      expect(typeof reviewing.pendingCompletionSubmittedAt).toBe('number');
    });

    it('accepts null submittedByNodeId for Task Agent / UI submissions', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);

      const reviewing = await manager.submitTaskForReview(task.id, {
        submittedByNodeId: null,
        reason: null,
      });

      expect(reviewing.status).toBe('review');
      expect(reviewing.pendingCheckpointType).toBe('task_completion');
      expect(reviewing.pendingCompletionSubmittedByNodeId).toBeNull();
      expect(reviewing.pendingCompletionReason).toBeNull();
    });

    it('allows repeated review→review submissions and refreshes pending-completion metadata', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);

      const first = await manager.submitTaskForReview(task.id, {
        submittedByNodeId: 'node-A',
        reason: 'cycle one',
      });

      const second = await manager.submitTaskForReview(task.id, {
        submittedByNodeId: 'node-B',
        reason: 'cycle two',
      });

      expect(second.status).toBe('review');
      expect(second.pendingCheckpointType).toBe('task_completion');
      expect(second.pendingCompletionSubmittedByNodeId).toBe('node-B');
      expect(second.pendingCompletionReason).toBe('cycle two');
      expect(second.pendingCompletionSubmittedAt).toBeGreaterThanOrEqual(
        first.pendingCompletionSubmittedAt ?? 0
      );
    });

    it('rejects review→review when pendingCheckpointType is gate', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);

      await manager.submitTaskForReview(task.id, {
        submittedByNodeId: null,
        reason: null,
      });
      const repo: any = (manager as any).taskRepo;
      repo.updateTask(task.id, {
        status: 'review',
        pendingCheckpointType: 'gate',
      });

      await expect(
        manager.submitTaskForReview(task.id, {
          submittedByNodeId: null,
          reason: null,
        })
      ).rejects.toThrow(/Cannot re-submit task in 'review' with pendingCheckpointType 'gate'/);

      const after = await manager.getTask(task.id);
      expect(after?.status).toBe('review');
      expect(after?.pendingCheckpointType).toBe('gate');
    });

    it('rejects illegal source statuses before any pending-* fields get written', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.completeTask(task.id, 'done');

      await expect(
        manager.submitTaskForReview(task.id, {
          submittedByNodeId: null,
          reason: null,
        })
      ).rejects.toThrow(/Invalid status transition/);

      const after = await manager.getTask(task.id);
      expect(after?.status).toBe('done');
      expect(after?.pendingCheckpointType).toBeFalsy();
      expect(after?.pendingCompletionSubmittedAt).toBeFalsy();
    });

    it('transitions blocked→review and stamps pending-completion fields', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.failTask(task.id, 'waiting for dependency');

      const reviewing = await manager.submitTaskForReview(task.id, {
        submittedByNodeId: 'node-B',
        reason: 'reviewer is ready to submit',
      });

      expect(reviewing.status).toBe('review');
      expect(reviewing.pendingCheckpointType).toBe('task_completion');
      expect(reviewing.pendingCompletionSubmittedByNodeId).toBe('node-B');
      expect(reviewing.pendingCompletionReason).toBe('reviewer is ready to submit');
    });

    it('transitions open→review and stamps pending-completion fields', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });

      const reviewing = await manager.submitTaskForReview(task.id, {
        submittedByNodeId: null,
        reason: 'review-only submit',
      });

      expect(reviewing.status).toBe('review');
      expect(reviewing.pendingCheckpointType).toBe('task_completion');
      expect(reviewing.pendingCompletionSubmittedByNodeId).toBeNull();
      expect(reviewing.pendingCompletionReason).toBe('review-only submit');
    });

    it('writes status and pending-completion fields in a single UPDATE (atomicity)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);

      // biome-ignore lint/suspicious/noExplicitAny: spy needs to reach into private repo
      const repo: any = (manager as any).taskRepo;
      const originalUpdate = repo.updateTask.bind(repo);
      const calls: Array<{ id: string; params: Record<string, unknown> }> = [];
      repo.updateTask = (id: string, params: Record<string, unknown>) => {
        calls.push({ id, params });
        return originalUpdate(id, params);
      };

      try {
        const result = await manager.submitTaskForReview(task.id, {
          submittedByNodeId: 'node-A',
          reason: 'ready',
        });

        expect(result.status).toBe('review');
        expect(result.pendingCheckpointType).toBe('task_completion');

        expect(calls).toHaveLength(1);
        const onlyCall = calls[0];
        expect(onlyCall.id).toBe(task.id);
        expect(onlyCall.params.status).toBe('review');
        expect(onlyCall.params.pendingCheckpointType).toBe('task_completion');
        expect(onlyCall.params.pendingCompletionSubmittedByNodeId).toBe('node-A');
        expect(onlyCall.params.pendingCompletionReason).toBe('ready');
        expect(typeof onlyCall.params.pendingCompletionSubmittedAt).toBe('number');
      } finally {
        repo.updateTask = originalUpdate;
      }
    });
  });

  describe('exit-status cleanup', () => {
    it('clears pending-* fields on review → in_progress (Reopen)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.submitTaskForReview(task.id, {
        submittedByNodeId: 'node-A',
        reason: 'please review',
      });

      const reopened = await manager.setTaskStatus(task.id, 'in_progress');
      expect(reopened.status).toBe('in_progress');
      expect(reopened.pendingCheckpointType).toBeNull();
      expect(reopened.pendingCompletionSubmittedByNodeId).toBeNull();
      expect(reopened.pendingCompletionSubmittedAt).toBeNull();
      expect(reopened.pendingCompletionReason).toBeNull();
      expect(reopened.postApprovalSourceNodeId).toBeNull();
    });

    it('clears pending-* fields on review → archived', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.submitTaskForReview(task.id, {
        submittedByNodeId: null,
        reason: 'go',
      });

      const archived = await manager.setTaskStatus(task.id, 'archived');
      expect(archived.status).toBe('archived');
      expect(archived.pendingCheckpointType).toBeNull();
      expect(archived.pendingCompletionSubmittedByNodeId).toBeNull();
      expect(archived.pendingCompletionSubmittedAt).toBeNull();
      expect(archived.pendingCompletionReason).toBeNull();
    });

    it('clears pending-* fields on review → cancelled', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.submitTaskForReview(task.id, {
        submittedByNodeId: 'node-Z',
        reason: 'risky',
      });

      const cancelled = await manager.setTaskStatus(task.id, 'cancelled');
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.pendingCheckpointType).toBeNull();
      expect(cancelled.pendingCompletionReason).toBeNull();
    });

    it('clears pending-* fields on review → done (human approval terminal write)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.submitTaskForReview(task.id, {
        submittedByNodeId: null,
        reason: null,
      });

      const done = await manager.setTaskStatus(task.id, 'done', {
        approvalSource: 'human',
      });
      expect(done.status).toBe('done');
      expect(done.pendingCheckpointType).toBeNull();
      expect(done.pendingCompletionSubmittedAt).toBeNull();
    });

    it('writes status flip and pending-* cleanup in a single UPDATE on review-exit (atomicity)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.submitTaskForReview(task.id, {
        submittedByNodeId: 'node-A',
        reason: 'r',
      });

      // biome-ignore lint/suspicious/noExplicitAny: spy needs to reach into private repo
      const repo: any = (manager as any).taskRepo;
      const originalUpdate = repo.updateTask.bind(repo);
      const calls: Array<{ id: string; params: Record<string, unknown> }> = [];
      repo.updateTask = (id: string, params: Record<string, unknown>) => {
        calls.push({ id, params });
        return originalUpdate(id, params);
      };

      try {
        await manager.setTaskStatus(task.id, 'in_progress');
        expect(calls).toHaveLength(1);
        const onlyCall = calls[0];
        expect(onlyCall.params.status).toBe('in_progress');
        expect(onlyCall.params.pendingCheckpointType).toBeNull();
        expect(onlyCall.params.pendingCompletionSubmittedByNodeId).toBeNull();
        expect(onlyCall.params.pendingCompletionSubmittedAt).toBeNull();
        expect(onlyCall.params.pendingCompletionReason).toBeNull();
      } finally {
        repo.updateTask = originalUpdate;
      }
    });

    it('clears post-approval-* fields on approved → done (mark_complete)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.setTaskStatus(task.id, 'approved', { approvalSource: 'agent' });
      await manager.updateTask(task.id, {
        postApprovalSessionId: 'sess-1',
        postApprovalStartedAt: Date.now(),
        postApprovalBlockedReason: null,
      });

      const done = await manager.setTaskStatus(task.id, 'done');
      expect(done.status).toBe('done');
      expect(done.postApprovalSessionId).toBeNull();
      expect(done.postApprovalStartedAt).toBeNull();
      expect(done.postApprovalBlockedReason).toBeNull();
    });

    it('clears post-approval-* fields on approved → in_progress (Reopen escape hatch)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.setTaskStatus(task.id, 'approved', { approvalSource: 'human' });
      await manager.updateTask(task.id, {
        postApprovalSessionId: 'sess-2',
        postApprovalStartedAt: 999,
        postApprovalBlockedReason: 'router unavailable',
      });

      const reopened = await manager.setTaskStatus(task.id, 'in_progress');
      expect(reopened.status).toBe('in_progress');
      expect(reopened.postApprovalSessionId).toBeNull();
      expect(reopened.postApprovalStartedAt).toBeNull();
      expect(reopened.postApprovalBlockedReason).toBeNull();
    });

    it('clears post-approval-* fields on approved → archived', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.setTaskStatus(task.id, 'approved', { approvalSource: 'human' });
      await manager.updateTask(task.id, {
        postApprovalSessionId: 'sess-3',
        postApprovalStartedAt: 1,
        postApprovalBlockedReason: null,
      });

      const archived = await manager.setTaskStatus(task.id, 'archived');
      expect(archived.status).toBe('archived');
      expect(archived.postApprovalSessionId).toBeNull();
      expect(archived.postApprovalStartedAt).toBeNull();
    });

    it('writes status flip and post-approval-* cleanup in a single UPDATE on approved → done (atomicity)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.setTaskStatus(task.id, 'approved', { approvalSource: 'agent' });
      await manager.updateTask(task.id, {
        postApprovalSessionId: 'sess-X',
        postApprovalStartedAt: 5,
        postApprovalBlockedReason: 'blocked-prior',
      });

      // biome-ignore lint/suspicious/noExplicitAny: spy needs to reach into private repo
      const repo: any = (manager as any).taskRepo;
      const originalUpdate = repo.updateTask.bind(repo);
      const calls: Array<{ id: string; params: Record<string, unknown> }> = [];
      repo.updateTask = (id: string, params: Record<string, unknown>) => {
        calls.push({ id, params });
        return originalUpdate(id, params);
      };

      try {
        await manager.setTaskStatus(task.id, 'done');
        expect(calls).toHaveLength(1);
        const onlyCall = calls[0];
        expect(onlyCall.params.status).toBe('done');
        expect(onlyCall.params.postApprovalSessionId).toBeNull();
        expect(onlyCall.params.postApprovalStartedAt).toBeNull();
        expect(onlyCall.params.postApprovalBlockedReason).toBeNull();
      } finally {
        repo.updateTask = originalUpdate;
      }
    });

    it('does not clear pending-* fields on same-status writes (review → review noop guard)', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.submitTaskForReview(task.id, {
        submittedByNodeId: 'node-A',
        reason: 'r',
      });

      await expect(manager.setTaskStatus(task.id, 'review')).rejects.toThrow(
        'Invalid status transition'
      );

      const after = await manager.getTask(task.id);
      expect(after?.pendingCheckpointType).toBe('task_completion');
      expect(after?.pendingCompletionReason).toBe('r');
    });
  });

  describe('workspacePath validation', () => {
    it('omission stores null', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      expect(task.workspacePath).toBeNull();
    });

    it('accepts a secondary workspace path and round-trips', async () => {
      const task = await manager.createTask({
        title: 'T',
        description: '',
        workspacePath: '/secondary',
      });
      const fetched = await manager.getTask(task.id);
      expect(fetched!.workspacePath).toBe('/secondary');
    });

    it('rejects an unregistered workspace path', async () => {
      await expect(
        manager.createTask({
          title: 'T',
          description: '',
          workspacePath: '/unregistered',
        })
      ).rejects.toThrow('Workspace path is not registered to space: /unregistered');
    });

    it('updates to a secondary workspace path and round-trips', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      const updated = await manager.updateTask(task.id, { workspacePath: '/secondary' });
      expect(updated.workspacePath).toBe('/secondary');
    });

    it('rejects an unregistered workspace path on update', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await expect(manager.updateTask(task.id, { workspacePath: '/unregistered' })).rejects.toThrow(
        'Workspace path is not registered to space: /unregistered'
      );
    });
  });
});
