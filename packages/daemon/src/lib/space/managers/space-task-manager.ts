import { DirectTaskExecutionRepository } from '../../../storage/repositories/direct-task-execution-repository.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { reopenDirectCompletion } from '../operations/reopen-pending-completion.ts';
import type { PendingCompletionReopenResult } from '../operations/pending-completion.ts';
import {
  prepareSpaceTaskStatusUpdate,
  prepareSpaceTaskReviewUpdate,
  isTerminalTaskStatus,
} from './task-status-preparation.ts';
import { PendingCompletionSupersededError } from '../operations/pending-completion-guard.ts';
import { publishTask } from '../../tasks/publication.ts';
import {
  VALID_TASK_TRANSITIONS as VALID_SPACE_TASK_TRANSITIONS,
  isValidTaskTransition as isValidSpaceTaskTransition,
  assertValidTaskTransition as assertValidSpaceTaskTransition,
} from '../../tasks/transitions.ts';

export { VALID_SPACE_TASK_TRANSITIONS, isValidSpaceTaskTransition, assertValidSpaceTaskTransition };

class StaleGuardCasMiss extends Error {}
export class StaleTaskGuardError extends Error {}

import { buildTaskDependencyGraph, hasTaskDependencyCycle } from '../../tasks/dependency-graph.ts';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import type {
  InternalCreateSpaceTaskParams,
  SpaceApprovalSource,
  SpaceBlockReason,
  SpaceTask,
  SpaceTaskStatus,
  UpdateSpaceTaskParams,
} from '@hyperneo/shared';
import { isRateOrUsageLimited } from '@hyperneo/shared';
import type { ReactiveDatabase } from '../../../storage/reactive-database.ts';
import { SpaceRepository } from '../../../storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { SpaceWorktreeRepository } from '../../../storage/repositories/space-worktree-repository.ts';
import { ChannelCycleRepository } from '../../../storage/repositories/channel-cycle-repository.ts';
import { Logger } from '../../logger.ts';
import type { EvolutionScopeService } from '../evolution-scope-service.ts';
import { arraysEqual } from '../../utils/array-utils.ts';

export type TaskExecutionPointers = Pick<
  UpdateSpaceTaskParams,
  'workflowRunId' | 'taskAgentSessionId'
>;

export type WorkspacePathResolver = (rawPath: string) => Promise<string>;

const log = new Logger('space-task-manager');

export class SpaceTaskManager {
  private taskRepo: SpaceTaskRepository;
  private worktreeRepo: SpaceWorktreeRepository;
  private spaceRepo: SpaceRepository;

  constructor(
    private db: BunDatabase,
    private spaceId: string,
    private reactiveDb?: ReactiveDatabase,
    private evolutionScopeService?: EvolutionScopeService,
    private onTaskReopened?: (taskId: string) => void,
    private onTerminalTransition?: (taskId: string, fromStatus: SpaceTaskStatus) => void,
    private resolveWorkspacePath?: WorkspacePathResolver
  ) {
    this.taskRepo = new SpaceTaskRepository(db, reactiveDb);
    this.worktreeRepo = new SpaceWorktreeRepository(db);
    this.spaceRepo = new SpaceRepository(db);
  }

  async createTask(params: Omit<InternalCreateSpaceTaskParams, 'spaceId'>): Promise<SpaceTask> {
    const resolvedParams = await this.resolveWorkspacePathParam(params);

    if (resolvedParams.dependsOn && resolvedParams.dependsOn.length > 0) {
      await this.validateDependencyIds(resolvedParams.dependsOn);
    }

    return this.taskRepo.createTask({ ...resolvedParams, spaceId: this.spaceId });
  }

  private async resolveWorkspacePathParam<T extends { workspacePath?: string | null }>(
    params: T
  ): Promise<T> {
    if (params.workspacePath === undefined) {
      return params;
    }
    if (params.workspacePath === null || params.workspacePath.length === 0) {
      return { ...params, workspacePath: null } as T;
    }
    if (!this.resolveWorkspacePath) {
      throw new Error('Workspace path validation is not available');
    }
    const resolved = await this.resolveWorkspacePath(params.workspacePath);
    const space = this.spaceRepo.getSpace(this.spaceId);
    if (space && resolved === space.workspacePath) {
      return { ...params, workspacePath: null } as T;
    }
    return { ...params, workspacePath: resolved } as T;
  }

  private hasActiveTaskSession(task: SpaceTask): boolean {
    return (
      !!task.taskAgentSessionId ||
      !!task.postApprovalSessionId ||
      task.status === 'in_progress' ||
      task.status === 'rate_limited' ||
      task.status === 'usage_limited'
    );
  }

  async getTask(taskId: string): Promise<SpaceTask | null> {
    const task = this.taskRepo.getTask(taskId);
    if (task && task.spaceId === this.spaceId) {
      return task;
    }
    return null;
  }

  async getTaskByNumber(taskNumber: number): Promise<SpaceTask | null> {
    return this.taskRepo.getTaskByNumber(this.spaceId, taskNumber);
  }

  async listTasks(includeArchived = false): Promise<SpaceTask[]> {
    return this.taskRepo.listBySpace(this.spaceId, includeArchived);
  }

  async listTasksByStatus(status: SpaceTaskStatus): Promise<SpaceTask[]> {
    return this.taskRepo.listByStatus(this.spaceId, status);
  }

  async listTasksByStatusPaginated(
    status: SpaceTaskStatus,
    blockReason: SpaceBlockReason | null | undefined,
    limit: number,
    offset = 0,
    blockReasonNotIn?: SpaceBlockReason[]
  ): Promise<{ tasks: SpaceTask[]; total: number }> {
    return this.taskRepo.listBySpaceAndStatus(
      this.spaceId,
      status,
      blockReason,
      limit,
      offset,
      blockReasonNotIn
    );
  }

  async listTasksByWorkflowRun(workflowRunId: string): Promise<SpaceTask[]> {
    return this.taskRepo.listByWorkflowRun(workflowRunId);
  }

  reopenPendingCompletion(
    taskId: string,
    reason: string | null,
    guard: { expectedPendingCompletionGeneration: number }
  ): Promise<PendingCompletionReopenResult> {
    return (
      superpipe({
        db: this.db,
        reactiveDb: this.reactiveDb,
        reason,
        expectedGeneration: guard.expectedPendingCompletionGeneration,
        onTaskReopened: this.onTaskReopened,
      })('reopen-pending-completion') as PipelineAPI
    )
      .input('taskId')
      .pipe((id: string) => this.getTask(id), 'taskId', 'current')
      .pipe(
        reopenDirectCompletion,
        ['db', 'reactiveDb', 'current', 'taskId', 'reason', 'expectedGeneration', 'onTaskReopened'],
        'result:task'
      )
      .pipe((task: SpaceTask) => this.setTaskStatus(task.id, 'in_progress', guard), 'task', 'task')
      .endAsync('task')(taskId) as Promise<PendingCompletionReopenResult>;
  }

  async setTaskStatus(
    taskId: string,
    newStatus: SpaceTaskStatus,
    options?: {
      result?: string | null;
      reportedSummary?: string | null;
      blockReason?: SpaceBlockReason;
      approvalSource?: SpaceApprovalSource;
      approvalReason?: string | null;
      expectedStatus?: SpaceTaskStatus;
      expectedWorkflowRunId?: string | null;
      expectedPendingCompletionGeneration?: number;
      expectedPostApprovalSessionId?: string | null;
      onCascadedTasks?: (cascaded: SpaceTask[]) => Promise<void>;
    }
  ): Promise<SpaceTask> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const expectedStatus = options?.expectedStatus;
    const expectedWorkflowRunId = options?.expectedWorkflowRunId;
    const staleStatusError = (currentStatus: SpaceTaskStatus) =>
      new StaleTaskGuardError(
        `Task ${taskId} is no longer '${expectedStatus}' (now '${currentStatus}')`
      );
    if (expectedStatus !== undefined && task.status !== expectedStatus) {
      throw staleStatusError(task.status);
    }
    if (
      expectedWorkflowRunId !== undefined &&
      (task.workflowRunId ?? null) !== expectedWorkflowRunId
    ) {
      throw new StaleTaskGuardError(
        `Task ${taskId} is no longer attached to workflow run '${expectedWorkflowRunId}' (now '${task.workflowRunId ?? null}')`
      );
    }

    const expectedGeneration = options?.expectedPendingCompletionGeneration;
    if (
      expectedGeneration !== undefined &&
      (task.status !== 'review' ||
        task.pendingCheckpointType !== 'task_completion' ||
        (task.pendingCompletionGeneration ?? 0) !== expectedGeneration)
    ) {
      throw new PendingCompletionSupersededError(taskId);
    }
    assertValidSpaceTaskTransition(task.status, newStatus);

    if (isRateOrUsageLimited(newStatus)) {
      throw new Error(
        `Status '${newStatus}' is runtime-owned: it is set only by the rate-limit pause path ` +
          `and cannot be written through generic status updates.`
      );
    }

    const { updates, reopened } = prepareSpaceTaskStatusUpdate(
      task,
      newStatus,
      options,
      Date.now()
    );
    this.reactiveDb?.beginTransaction();
    let updated: SpaceTask;
    try {
      updated = this.db.transaction(() => {
        const result = this.taskRepo.updateTask(
          taskId,
          updates,
          expectedStatus,
          expectedGeneration,
          options?.expectedPostApprovalSessionId,
          expectedWorkflowRunId
        );
        if (!result) {
          if (
            expectedStatus === undefined &&
            expectedWorkflowRunId === undefined &&
            expectedGeneration === undefined &&
            options?.expectedPostApprovalSessionId === undefined
          )
            throw new Error(`Failed to update task: ${taskId}`);
          throw new StaleGuardCasMiss();
        }
        if (reopened) {
          this.onTaskReopened?.(taskId);
        }
        if (isTerminalTaskStatus(newStatus)) {
          this.onTerminalTransition?.(taskId, task.status);
        }
        return result;
      })();
      this.reactiveDb?.commitTransaction();
    } catch (err) {
      this.reactiveDb?.abortTransaction();
      if (err instanceof StaleGuardCasMiss) {
        const current = await this.getTask(taskId);
        if (!current) {
          throw new Error(`Task not found: ${taskId}`);
        }
        const generationMismatch =
          expectedGeneration !== undefined &&
          (current.status !== 'review' ||
            current.pendingCheckpointType !== 'task_completion' ||
            (current.pendingCompletionGeneration ?? 0) !== expectedGeneration);
        if (generationMismatch) {
          throw new PendingCompletionSupersededError(taskId);
        }
        if (expectedStatus !== undefined && current.status !== expectedStatus) {
          throw staleStatusError(current.status);
        }
        if (
          expectedWorkflowRunId !== undefined &&
          (current.workflowRunId ?? null) !== expectedWorkflowRunId
        ) {
          throw new StaleTaskGuardError(
            `Task ${taskId} is no longer attached to workflow run '${expectedWorkflowRunId}' (now '${current.workflowRunId ?? null}')`
          );
        }
        const expectedPostApprovalSessionId = options?.expectedPostApprovalSessionId;
        if (
          expectedPostApprovalSessionId !== undefined &&
          (current.postApprovalSessionId ?? null) !== expectedPostApprovalSessionId
        ) {
          throw new StaleTaskGuardError(
            `Task ${taskId} is no longer awaiting post-approval session '${expectedPostApprovalSessionId}' (now '${current.postApprovalSessionId ?? null}')`
          );
        }
        throw new StaleTaskGuardError(
          `Task ${taskId} lost a guarded update race (now '${current.status}')`
        );
      }
      throw err;
    }

    if (newStatus === 'done') {
      if (!task.goalId) {
        try {
          this.evolutionScopeService?.captureCompletedTaskEvidence({ taskId });
        } catch (err) {
          log.warn(
            `Forge evidence capture threw for task "${taskId}": ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      try {
        const unblocked = await this.unblockDependentTasks(taskId);
        if (unblocked.length > 0 && options?.onCascadedTasks) {
          await options.onCascadedTasks(unblocked);
        }
      } catch {}
    }

    if (newStatus === 'archived' && updated.workflowRunId) {
      const runTasks = this.taskRepo.listByWorkflowRunIncludingArchived(updated.workflowRunId);
      if (runTasks.length > 0 && runTasks.every((t) => t.archivedAt != null)) {
        try {
          new ChannelCycleRepository(this.db).resetAllForRun(updated.workflowRunId);
        } catch (err) {
          log.warn(
            `Failed to clear dead-loop history for archived run "${updated.workflowRunId}": ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    return updated;
  }

  async startTask(taskId: string): Promise<SpaceTask> {
    return this.setTaskStatus(taskId, 'in_progress');
  }

  async publishTask(taskId: string): Promise<SpaceTask> {
    const task = await publishTask(
      async () => (await this.getTask(taskId))?.status,
      async () => this.taskRepo.updateTask(taskId, { status: 'open' }, 'draft') ?? 'not_draft'
    );
    if (task === 'not_draft') {
      throw new Error('Only draft tasks can be published');
    }
    return task;
  }

  async submitTaskForReview(
    taskId: string,
    opts: {
      submittedByNodeId: string | null;
      reason: string | null;
    }
  ): Promise<SpaceTask> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status === 'review') {
      if (task.pendingCheckpointType !== 'task_completion' && task.pendingCheckpointType != null) {
        throw new Error(
          `Cannot re-submit task in 'review' with pendingCheckpointType '${task.pendingCheckpointType}'. ` +
            `Only 'task_completion' checkpoints can be refreshed.`
        );
      }
    } else if (!isValidSpaceTaskTransition(task.status, 'review')) {
      throw new Error(
        `Invalid status transition from '${task.status}' to 'review'. ` +
          `Allowed: ${VALID_SPACE_TASK_TRANSITIONS[task.status].join(', ') || 'none'}`
      );
    }

    const updated = this.db.transaction(() => {
      if (new DirectTaskExecutionRepository(this.db).getActive(taskId)?.phase === 'reserved')
        throw new Error(
          `Task ${taskId} cannot be submitted for review while its direct start is queued`
        );
      return this.taskRepo.updateTask(taskId, prepareSpaceTaskReviewUpdate(opts, Date.now()));
    }, 'immediate')();
    if (!updated) {
      throw new Error(`Failed to submit task for review: ${taskId}`);
    }
    return updated;
  }

  async completeTask(taskId: string, result: string): Promise<SpaceTask> {
    return this.setTaskStatus(taskId, 'done', { result });
  }

  async failTask(
    taskId: string,
    error?: string,
    blockReason?: SpaceBlockReason
  ): Promise<SpaceTask> {
    return this.setTaskStatus(taskId, 'blocked', {
      ...(error ? { result: error } : {}),
      blockReason,
    });
  }

  async cancelTask(taskId: string): Promise<SpaceTask> {
    const all = await this.cancelTaskCascade(taskId);
    return all[0];
  }

  async cancelTaskCascade(taskId: string): Promise<SpaceTask[]> {
    return this.doCancelCascade(taskId, []);
  }

  private async doCancelCascade(taskId: string, acc: SpaceTask[]): Promise<SpaceTask[]> {
    const result = await this.setTaskStatus(taskId, 'cancelled');
    acc.push(result);

    const pendingTasks = await this.listTasksByStatus('open');
    for (const t of pendingTasks) {
      if (t.dependsOn?.includes(taskId)) {
        await this.doCancelCascade(t.id, acc);
      }
    }

    return acc;
  }

  async promoteDraftTasks(creatorTaskId: string): Promise<number> {
    return this.taskRepo.promoteDraftTasksByCreator(creatorTaskId);
  }

  async archiveTask(taskId: string): Promise<SpaceTask> {
    return this.setTaskStatus(taskId, 'archived');
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const task = await this.getTask(taskId);
    if (!task) {
      return false;
    }

    return this.taskRepo.deleteTask(taskId);
  }

  private validateTaskFieldGuards(task: SpaceTask, params: UpdateSpaceTaskParams): void {
    if (params.status !== undefined && params.status !== task.status) {
      throw new Error('Use setTaskStatus to change task status — it enforces valid transitions');
    }

    const targetWorkspacePath = params.workspacePath;
    if (targetWorkspacePath !== undefined && targetWorkspacePath !== task.workspacePath) {
      if (this.hasActiveTaskSession(task)) {
        throw new Error(
          `Cannot change task workspace path: task ${task.id} has an active or started agent session`
        );
      }
      const worktree = this.worktreeRepo.getByTaskId(this.spaceId, task.id);
      if (worktree) {
        throw new Error(
          `Cannot change task workspace path: task ${task.id} already has a worktree at ${worktree.path}`
        );
      }
    }
  }

  async updateTask(
    taskId: string,
    params: UpdateSpaceTaskParams,
    options?: {
      prepareExecutionPointers?: (
        current: Readonly<SpaceTask>,
        requested: Readonly<TaskExecutionPointers>
      ) => TaskExecutionPointers;
      onCascadedTasks?: (cascaded: SpaceTask[]) => Promise<void>;
    }
  ): Promise<SpaceTask> {
    const resolvedParams = await this.resolveWorkspacePathParam(params);

    let task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    this.validateTaskFieldGuards(task, resolvedParams);

    if (resolvedParams.dependsOn !== undefined) {
      await this.validateDependencyIds(resolvedParams.dependsOn, taskId);
    }

    const { status: _status, ...repoParams } = resolvedParams;
    let updated: SpaceTask | null;
    const prepare = options?.prepareExecutionPointers;
    if (prepare) {
      const quietRepo = new SpaceTaskRepository(this.db);
      const written = this.db.transaction(() => {
        const current = quietRepo.getTask(taskId);
        if (!current || current.spaceId !== this.spaceId)
          throw new Error(`Task not found: ${taskId}`);
        this.validateTaskFieldGuards(current, resolvedParams);
        const { workflowRunId, taskAgentSessionId, ...fields } = repoParams;
        const pointers = prepare(current, { workflowRunId, taskAgentSessionId });
        const result = quietRepo.updateTask(taskId, {
          ...fields,
          workflowRunId: pointers.workflowRunId,
          taskAgentSessionId: pointers.taskAgentSessionId,
        });
        if (!result) throw new Error(`Failed to update task: ${taskId}`);
        return { previous: current, updated: result };
      }, 'immediate')();
      task = written.previous;
      updated = written.updated;
      this.reactiveDb?.notifyChange('space_tasks');
    } else {
      updated = this.taskRepo.updateTask(taskId, repoParams);
    }
    const depsChanged =
      resolvedParams.dependsOn !== undefined &&
      !arraysEqual(task.dependsOn ?? [], resolvedParams.dependsOn);

    if (!updated) {
      throw new Error(`Failed to update task: ${taskId}`);
    }

    if (depsChanged) {
      const depsMet = await this.areDependenciesMet(updated);
      if (!depsMet && updated.status === 'in_progress') {
        const blocked = await this.setTaskStatus(taskId, 'blocked', {
          blockReason: 'dependency_added',
          result: 'Dependency added while task was in progress',
        });
        const cascaded = await this.blockDependentTasks(taskId);
        if (cascaded.length > 0 && options?.onCascadedTasks) {
          await options.onCascadedTasks(cascaded);
        }
        return blocked;
      } else if (
        depsMet &&
        updated.status === 'blocked' &&
        (updated.blockReason === 'dependency_added' || updated.blockReason === 'dependency_failed')
      ) {
        return this.setTaskStatus(taskId, 'open');
      }
    }

    return updated;
  }

  async retryTask(taskId: string, options?: { description?: string }): Promise<SpaceTask> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const retryableStatuses: SpaceTaskStatus[] = ['blocked', 'cancelled', 'done'];
    if (!retryableStatuses.includes(task.status)) {
      throw new Error(
        `Cannot retry task in '${task.status}' status. Task must be in 'blocked', 'cancelled', or 'done' status.`
      );
    }

    const targetStatus: SpaceTaskStatus =
      task.status === 'done' || task.status === 'cancelled' ? 'in_progress' : 'open';
    const retried = await this.setTaskStatus(taskId, targetStatus);

    if (options?.description !== undefined) {
      return this.updateTask(taskId, { description: options.description });
    }

    return retried;
  }

  async reassignTask(
    taskId: string,
    _customAgentId?: string | null,
    _assignedAgent?: string
  ): Promise<SpaceTask> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const allowedStatuses: SpaceTaskStatus[] = ['open', 'blocked', 'cancelled', 'done'];
    if (!allowedStatuses.includes(task.status)) {
      throw new Error(
        `Cannot reassign task in '${task.status}' status. Task must be in 'open', 'blocked', 'cancelled', or 'done' status.`
      );
    }

    return task;
  }

  async areDependenciesMet(task: SpaceTask): Promise<boolean> {
    if (!task.dependsOn || task.dependsOn.length === 0) {
      return true;
    }

    for (const depId of task.dependsOn) {
      const dep = await this.getTask(depId);
      if (!dep || dep.status !== 'done') {
        return false;
      }
    }

    return true;
  }

  async blockDependentTasks(taskId: string): Promise<SpaceTask[]> {
    return this.doBlockCascade(taskId, []);
  }

  async cancelDependentTasks(taskId: string): Promise<SpaceTask[]> {
    return this.doCancelDependentsCascade(taskId, []);
  }

  private async doBlockCascade(taskId: string, acc: SpaceTask[]): Promise<SpaceTask[]> {
    const dependents = [
      ...(await this.listTasksByStatus('in_progress')),
      ...(await this.listTasksByStatus('rate_limited')),
      ...(await this.listTasksByStatus('usage_limited')),
    ];
    for (const t of dependents) {
      if (acc.some((a) => a.id === t.id)) continue;
      if (t.dependsOn?.includes(taskId)) {
        const blocked = await this.setTaskStatus(t.id, 'blocked', {
          blockReason: 'dependency_failed',
          result: `Dependency task ${taskId} failed or was cancelled`,
        });
        acc.push(blocked);
        await this.doBlockCascade(t.id, acc);
      }
    }
    return acc;
  }

  private async doCancelDependentsCascade(
    taskId: string,
    acc: SpaceTask[],
    visited: Set<string> = new Set()
  ): Promise<SpaceTask[]> {
    const allTasks = await this.listTasks(false);
    for (const t of allTasks) {
      if (visited.has(t.id)) continue;
      if (!t.dependsOn?.includes(taskId)) continue;
      visited.add(t.id);

      let propagate = false;
      if (t.status === 'open' || t.status === 'in_progress' || isRateOrUsageLimited(t.status)) {
        const cancelled = await this.setTaskStatus(t.id, 'cancelled', {
          result: `Dependency task ${taskId} was cancelled`,
        });
        acc.push(cancelled);
        propagate = true;
      } else if (t.status === 'cancelled') {
        propagate = true;
      }

      if (propagate) {
        await this.doCancelDependentsCascade(t.id, acc, visited);
      }
    }
    return acc;
  }

  async unblockDependentTasks(taskId: string): Promise<SpaceTask[]> {
    const unblocked: SpaceTask[] = [];
    const allTasks = await this.listTasks(false);
    for (const t of allTasks) {
      if (t.status !== 'blocked') continue;
      if (t.blockReason !== 'dependency_failed' && t.blockReason !== 'dependency_added') continue;
      if (!t.dependsOn?.includes(taskId)) continue;
      const depsMet = await this.areDependenciesMet(t);
      if (depsMet) {
        try {
          const reopened = await this.setTaskStatus(t.id, 'open');
          unblocked.push(reopened);
        } catch {}
      }
    }
    return unblocked;
  }

  private async validateDependencyIds(depIds: string[], taskId?: string): Promise<void> {
    for (const depId of depIds) {
      if (taskId && depId === taskId) {
        throw new Error('A task cannot depend on itself');
      }
      const dep = await this.getTask(depId);
      if (!dep) {
        throw new Error(`Dependency task not found in space: ${depId}`);
      }
    }

    if (taskId && depIds.length > 0) {
      const allTasks = await this.listTasks(true);
      const adj = buildTaskDependencyGraph(allTasks, taskId, depIds);
      if (hasTaskDependencyCycle(adj)) {
        throw new Error('Adding these dependencies would create a circular dependency');
      }
    }
  }
}
