/**
 * SpaceTaskManager Tests
 *
 * Tests task lifecycle, status transitions, and dependency validation.
 */

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
    manager = new SpaceTaskManager(db as any, spaceId);
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
      // Create another space and its manager
      const otherSpace = spaceRepo.createSpace({
        workspacePath: '/workspace/other',
        slug: 'other-space',
        name: 'Other',
      });
      const otherManager = new SpaceTaskManager(db as any, otherSpace.id);
      const otherTask = await otherManager.createTask({ title: 'T', description: '' });

      // Task from other space is not visible
      expect(await manager.getTask(otherTask.id)).toBeNull();
    });
  });

  describe('setTaskStatus', () => {
    it('transitions open -> in_progress', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      const updated = await manager.setTaskStatus(task.id, 'in_progress');
      expect(updated.status).toBe('in_progress');
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
      await expect(manager.setTaskStatus(task.id, 'archived')).rejects.toThrow(
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
      // Runtime pauses t2 (rate/usage-limited is runtime-set, not a user
      // transition) and cancels t1, then calls cancelDependentTasks.
      await manager.setTaskStatus(t2.id, 'in_progress');
      db.prepare(`UPDATE space_tasks SET status = 'usage_limited' WHERE id = ?`).run(t2.id);
      db.prepare(`UPDATE space_tasks SET status = 'cancelled' WHERE id = ?`).run(t1.id);

      await manager.cancelDependentTasks(t1.id);

      // A paused dependent must be cancelled with its prerequisite, otherwise
      // recoverRateLimitedTasks would later restore it to in_progress despite
      // the cancelled dependency.
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
      // Runtime-set paused status (not a user transition) — write directly.
      db.prepare(`UPDATE space_tasks SET status = 'rate_limited' WHERE id = ?`).run(t2.id);

      await manager.blockDependentTasks(t1.id);

      // A paused dependent must be blocked (not left to auto-resume) when its
      // prerequisite fails.
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

    it('throws when archiving a task in open status', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await expect(manager.archiveTask(task.id)).rejects.toThrow(
        "Invalid status transition from 'open' to 'archived'"
      );
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

      // Verify fields are set before retry
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
      // reassignTask is currently a no-op (agent fields removed), returns task unchanged
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

      // Verify done state
      const completed = await manager.getTask(task.id);
      expect(completed!.status).toBe('done');
      expect(completed!.result).toBe('done');

      // Reactivate — should succeed without any cleanup blocking it
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

    it('blocked allows restart, review, cancellation, and archival', () => {
      expect(VALID_SPACE_TASK_TRANSITIONS.blocked).toEqual([
        'open',
        'in_progress',
        'review',
        'cancelled',
        'archived',
      ]);
    });

    it('archived is a true terminal state with no transitions', () => {
      expect(VALID_SPACE_TASK_TRANSITIONS.archived).toEqual([]);
    });

    it('open allows in_progress, blocked, review, done, and cancelled', () => {
      expect(VALID_SPACE_TASK_TRANSITIONS.open).toEqual([
        'in_progress',
        'blocked',
        'review',
        'done',
        'cancelled',
      ]);
    });

    it('in_progress allows open, review, approved, done, blocked, and cancelled', () => {
      // `approved` was added in PR 2/5 of the task-agent-as-post-approval
      // executor refactor; end-node `approve_task` transitions `in_progress →
      // approved` so the post-approval router can dispatch.
      expect(VALID_SPACE_TASK_TRANSITIONS.in_progress).toEqual([
        'open',
        'review',
        'approved',
        'done',
        'blocked',
        'cancelled',
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

    it('rejects transition from open -> archived', async () => {
      const task = await manager.createTask({ title: 'T', description: '' });
      await expect(manager.setTaskStatus(task.id, 'archived')).rejects.toThrow(
        'Invalid status transition'
      );
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
      // Can't test self-dep on create since the task ID doesn't exist yet;
      // test via updateTask instead
      const t = await manager.createTask({ title: 'T', description: '' });
      await expect(manager.updateTask(t.id, { dependsOn: [t.id] })).rejects.toThrow(
        'cannot depend on itself'
      );
    });

    it('rejects circular dependency A→B→A on update', async () => {
      const a = await manager.createTask({ title: 'A', description: '' });
      const b = await manager.createTask({ title: 'B', description: '', dependsOn: [a.id] });

      // Try to make A depend on B — creates A→B→A cycle
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
      await manager.startTask(b.id); // B is in_progress when A fails
      await manager.failTask(a.id, 'crashed', 'agent_crashed');

      const cascaded = await manager.blockDependentTasks(a.id);
      expect(cascaded).toHaveLength(1);
      expect(cascaded[0].id).toBe(b.id);
      expect(cascaded[0].status).toBe('blocked');
      expect(cascaded[0].blockReason).toBe('dependency_failed');
    });

    it('does NOT block open tasks waiting on the failed dependency', async () => {
      // Regression: a daemon restart cascades blocked status from a stalled
      // in_progress task to all dependents. Open tasks waiting on the dep
      // must remain `open` so the runtime can pick them up once the
      // dependency eventually completes (manual retry, etc.).
      const a = await manager.createTask({ title: 'A', description: '' });
      const b = await manager.createTask({ title: 'B', description: '', dependsOn: [a.id] });

      await manager.startTask(a.id);
      await manager.failTask(a.id, 'crashed', 'agent_crashed');

      // B is still `open` (never started)
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

      // All three are in_progress when A fails.
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

      // Complete C (done); leave B in `open` before A fails.
      await manager.startTask(c.id);
      await manager.completeTask(c.id, 'done');

      await manager.startTask(a.id);
      await manager.failTask(a.id, 'crashed');

      const cascaded = await manager.blockDependentTasks(a.id);
      // Neither B (open) nor C (done) should be affected.
      expect(cascaded).toHaveLength(0);
      expect((await manager.getTask(b.id))!.status).toBe('open');
      expect((await manager.getTask(c.id))!.status).toBe('done');
    });

    it('does not double-block in diamond dependency graph', async () => {
      const a = await manager.createTask({ title: 'A', description: '' });
      const b = await manager.createTask({ title: 'B', description: '', dependsOn: [a.id] });
      // D depends on both A (direct) and B (indirect via A)
      const d = await manager.createTask({
        title: 'D',
        description: '',
        dependsOn: [a.id, b.id],
      });

      // Both B and D are in_progress when A fails.
      await manager.startTask(a.id);
      await manager.startTask(b.id);
      await manager.startTask(d.id);
      await manager.failTask(a.id, 'crashed');

      // Should not throw; both B and D should end up blocked
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

      // Cancel the parent.
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
      // Regression: A → B → C, with B already cancelled and C still open.
      // Calling cancelDependentTasks(A) must walk through B to cancel C,
      // otherwise C is left stranded with an unmet dependency on B.
      const a = await manager.createTask({ title: 'A', description: '' });
      const b = await manager.createTask({ title: 'B', description: '', dependsOn: [a.id] });
      const c = await manager.createTask({ title: 'C', description: '', dependsOn: [b.id] });

      // B was cancelled before A.
      await manager.startTask(b.id);
      await manager.setTaskStatus(b.id, 'cancelled');

      // A is now cancelled; the cascade must reach C through the cancelled B.
      await manager.startTask(a.id);
      await manager.setTaskStatus(a.id, 'cancelled');

      const cascaded = await manager.cancelDependentTasks(a.id);
      // Only C transitions (B was already cancelled and is just a waypoint).
      expect(cascaded.map((t) => t.id)).toContain(c.id);
      expect((await manager.getTask(c.id))!.status).toBe('cancelled');
      expect((await manager.getTask(b.id))!.status).toBe('cancelled');
    });

    it('does not cascade through done/review/approved/blocked intermediates', async () => {
      // Regression for over-propagation: if A is retried→cancelled, B (deps:[A])
      // is already `done`, and C (deps:[B]) is still `open`, cancelling A must
      // NOT cancel C — B is a satisfied dependency for C.
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

      // B finished successfully.
      await manager.startTask(bDone.id);
      await manager.completeTask(bDone.id, 'ok');

      // A is now cancelled (e.g., retried then aborted).
      await manager.startTask(a.id);
      await manager.setTaskStatus(a.id, 'cancelled');

      const cascaded = await manager.cancelDependentTasks(a.id);
      // Neither B (done) nor C (downstream of done) should be cancelled.
      expect(cascaded).toHaveLength(0);
      expect((await manager.getTask(bDone.id))!.status).toBe('done');
      expect((await manager.getTask(cOpen.id))!.status).toBe('open');
    });

    it('does not cascade through a blocked intermediate', async () => {
      // Same shape as above but B is `blocked` (transient/retryable). Its
      // downstream C must still not be cancelled — once B is unblocked C
      // becomes runnable again.
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
      // Fire 20 async createTask calls concurrently via Promise.all.
      // The db.transaction() in the repository serialises the SELECT MAX + INSERT,
      // so each task should get a unique, monotonically increasing taskNumber.
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

  // ─── submitTaskForReview ────────────────────────────────────────────────
  //
  // Single entry point for the agent `submit_for_approval` tool, the Task Agent
  // self-submit path, and the UI "Submit for Review" RPC. The contract: any task
  // landing in `review` MUST carry the pending-completion fields so
  // `PendingTaskCompletionBanner` renders and approvals route through
  // `PostApprovalRouter`. These tests pin that atomic write contract end-to-end
  // against a real SQLite database.
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
      expect(typeof reviewing.pendingCompletionSubmittedAt).toBe('number');
    });

    it('accepts null submittedByNodeId for Task Agent / UI submissions', async () => {
      // Task Agent self-submit and UI "Submit for Review" both pass null —
      // no waiting end-node session to resume. The PostApprovalRouter
      // distinguishes these cases via `pendingCompletionSubmittedByNodeId`.
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

      // Simulate handleGatePendingApproval: put task in review with gate checkpoint
      await manager.submitTaskForReview(task.id, {
        submittedByNodeId: null,
        reason: null,
      });
      // Directly update to simulate gate pending state
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

      // Confirm gate checkpoint was not overwritten
      const after = await manager.getTask(task.id);
      expect(after?.status).toBe('review');
      expect(after?.pendingCheckpointType).toBe('gate');
    });

    it('rejects illegal source statuses before any pending-* fields get written', async () => {
      // `done → review` is not in VALID_SPACE_TASK_TRANSITIONS — the helper
      // must surface the transition error from `setTaskStatus` *before*
      // touching the pending-completion columns. Otherwise a banner would
      // render on top of an already-completed task.
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.completeTask(task.id, 'done');

      await expect(
        manager.submitTaskForReview(task.id, {
          submittedByNodeId: null,
          reason: null,
        })
      ).rejects.toThrow(/Invalid status transition/);

      // Confirm no partial write — task is still `done` with no pending fields.
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
      // Task stays in `open` — e.g. a review-only workflow where the
      // reviewer node activates before the task ever hits `in_progress`.

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
      // Atomicity regression guard. The earlier two-step implementation
      // (setTaskStatus + follow-up updateTask) exposed a window where
      // `status='review'` was visible without `pendingCheckpointType` set —
      // the exact banner-less state this PR was supposed to eliminate. We
      // pin the contract by spying on the underlying repository: on a
      // successful submit, exactly ONE write must reach the DB and that
      // write must carry both the status flip and the pending-* fields
      // together.
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);

      // Wrap the live repo's `updateTask` so we can count calls without
      // breaking real DB writes. (Using bun:sqlite directly keeps the
      // downstream pendingCheckpointType read in this test honest.)
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

        // Exactly one repo.updateTask call — no two-write race window.
        expect(calls).toHaveLength(1);
        const onlyCall = calls[0];
        expect(onlyCall.id).toBe(task.id);
        // Both the status flip AND the pending-* fields ride the same UPDATE.
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

  // ─── Exit-status cleanup (review-out, approved-out) ─────────────────────
  //
  // Counterpart to the entry-side `submitTaskForReview` atomic write. The
  // `setTaskStatus` helper now nulls the pending-completion fields on any
  // transition out of `review`, and nulls the post-approval tracking
  // fields on any transition out of `approved`, in the SAME SQL UPDATE
  // that flips the status. These tests pin that contract end-to-end so:
  //   - UI generic transitions (Reopen/Archive a `review` task, Mark
  //     Done/Reopen/Archive an `approved` task) get the cleanup for free —
  //     no banner-on-non-review state, no stale post-approval fields on
  //     terminal tasks.
  //   - The agent-tool simplifications (`mark_complete` no longer does a
  //     follow-up `updateTask`) stay correct.
  describe('exit-status cleanup', () => {
    // --- review-exit -----------------------------------------------------

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
        // Cleanup rides the same UPDATE — no separate write.
        expect(onlyCall.params.pendingCheckpointType).toBeNull();
        expect(onlyCall.params.pendingCompletionSubmittedByNodeId).toBeNull();
        expect(onlyCall.params.pendingCompletionSubmittedAt).toBeNull();
        expect(onlyCall.params.pendingCompletionReason).toBeNull();
      } finally {
        repo.updateTask = originalUpdate;
      }
    });

    // --- approved-exit ---------------------------------------------------

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
      // Atomicity regression guard for the centralised "exit approved"
      // cleanup. The earlier two-step `mark_complete` implementation
      // (setTaskStatus → updateTask) exposed a window where status='done'
      // was visible alongside stale post-approval fields. This test pins
      // the contract that the new single-UPDATE form holds.
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
        // All three post-approval-* fields cleared in the same UPDATE.
        expect(onlyCall.params.postApprovalSessionId).toBeNull();
        expect(onlyCall.params.postApprovalStartedAt).toBeNull();
        expect(onlyCall.params.postApprovalBlockedReason).toBeNull();
      } finally {
        repo.updateTask = originalUpdate;
      }
    });

    // --- guard: same-status writes don't trigger the cleanup -------------

    it('does not clear pending-* fields on same-status writes (review → review noop guard)', async () => {
      // `setTaskStatus` rejects same-status writes (no entry in the
      // transition table). The cleanup branch keys off `task.status !==
      // newStatus`, so even if a future caller tries to flip review→review
      // it would never reach the cleanup. Pinned defensively so this stays
      // safe even if the transition table is widened.
      const task = await manager.createTask({ title: 'T', description: '' });
      await manager.startTask(task.id);
      await manager.submitTaskForReview(task.id, {
        submittedByNodeId: 'node-A',
        reason: 'r',
      });

      await expect(manager.setTaskStatus(task.id, 'review')).rejects.toThrow(
        'Invalid status transition'
      );

      // Pending fields untouched.
      const after = await manager.getTask(task.id);
      expect(after?.pendingCheckpointType).toBe('task_completion');
      expect(after?.pendingCompletionReason).toBe('r');
    });
  });
});
