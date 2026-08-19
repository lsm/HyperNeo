import type { Database as BunDatabase } from '../../../storage/sqlite-compat';
import type {
  InternalCreateSpaceTaskParams,
  SpaceApprovalSource,
  SpaceBlockReason,
  SpaceTask,
  SpaceTaskStatus,
  UpdateSpaceTaskParams,
} from '@hyperneo/shared';
import { isRateOrUsageLimited } from '@hyperneo/shared';
import type { ReactiveDatabase } from '../../../storage/reactive-database';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import { ChannelCycleRepository } from '../../../storage/repositories/channel-cycle-repository';
import { Logger } from '../../logger';
import type { EvolutionScopeService } from '../evolution-scope-service';
import { arraysEqual } from '../../utils/array-utils';

const log = new Logger('space-task-manager');

export const VALID_SPACE_TASK_TRANSITIONS: Record<SpaceTaskStatus, SpaceTaskStatus[]> = {
  draft: ['open', 'archived'],
  open: ['in_progress', 'blocked', 'review', 'done', 'cancelled', 'archived'],
  in_progress: ['open', 'review', 'approved', 'done', 'blocked', 'cancelled', 'stopped'],
  review: ['done', 'approved', 'in_progress', 'cancelled', 'archived', 'stopped'],
  approved: ['done', 'in_progress', 'archived', 'cancelled'],
  done: ['in_progress', 'archived'],
  blocked: ['open', 'in_progress', 'review', 'done', 'cancelled', 'archived', 'stopped'],
  cancelled: ['open', 'in_progress', 'done', 'archived'],
  rate_limited: ['in_progress', 'open', 'blocked', 'cancelled', 'archived', 'stopped'],
  usage_limited: ['in_progress', 'open', 'blocked', 'cancelled', 'archived', 'stopped'],
  archived: [],
  stopped: ['in_progress', 'open', 'review', 'cancelled', 'archived'],
};

export function isValidSpaceTaskTransition(from: SpaceTaskStatus, to: SpaceTaskStatus): boolean {
  return VALID_SPACE_TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

export class SpaceTaskManager {
  private taskRepo: SpaceTaskRepository;

  constructor(
    private db: BunDatabase,
    private spaceId: string,
    private reactiveDb?: ReactiveDatabase,
    private evolutionScopeService?: EvolutionScopeService
  ) {
    this.taskRepo = new SpaceTaskRepository(db, reactiveDb);
  }

  async createTask(params: Omit<InternalCreateSpaceTaskParams, 'spaceId'>): Promise<SpaceTask> {
    if (params.dependsOn && params.dependsOn.length > 0) {
      await this.validateDependencyIds(params.dependsOn);
    }

    return this.taskRepo.createTask({ ...params, spaceId: this.spaceId });
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

  async setTaskStatus(
    taskId: string,
    newStatus: SpaceTaskStatus,
    options?: {
      result?: string | null;
      reportedSummary?: string | null;
      blockReason?: SpaceBlockReason;
      approvalSource?: SpaceApprovalSource;
      approvalReason?: string | null;
      onCascadedTasks?: (cascaded: SpaceTask[]) => Promise<void>;
    }
  ): Promise<SpaceTask> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (!isValidSpaceTaskTransition(task.status, newStatus)) {
      throw new Error(
        `Invalid status transition from '${task.status}' to '${newStatus}'. ` +
          `Allowed: ${VALID_SPACE_TASK_TRANSITIONS[task.status].join(', ') || 'none'}`
      );
    }

    const updates: Parameters<SpaceTaskRepository['updateTask']>[1] = { status: newStatus };

    if (newStatus === 'done' || newStatus === 'blocked') {
      if (options?.result !== undefined) {
        updates.result = options.result;
      } else if (!task.result && options?.reportedSummary !== null) {
        const summary = options?.reportedSummary ?? task.reportedSummary;
        if (summary) updates.result = summary;
      } else if (task.status === 'blocked' && newStatus === 'done') {
        const summary =
          options?.reportedSummary !== undefined ? options.reportedSummary : task.reportedSummary;
        updates.result = summary ?? null;
      }
      if (options?.reportedSummary !== undefined) {
        updates.reportedSummary = options.reportedSummary;
      }
    }

    if (newStatus === 'blocked') {
      updates.blockReason = options?.blockReason ?? null;
    } else if (task.status === 'blocked' && newStatus !== 'stopped') {
      updates.blockReason = null;
    }

    if (task.status === 'review' && newStatus === 'done') {
      updates.approvalSource = options?.approvalSource ?? null;
      updates.approvalReason = options?.approvalReason ?? null;
      updates.approvedAt = Date.now();
    }

    if (newStatus === 'approved') {
      updates.approvalSource = options?.approvalSource ?? null;
      updates.approvalReason = options?.approvalReason ?? null;
      updates.approvedAt = Date.now();
    }

    if (task.status === 'approved' && newStatus === 'done') {
      if (options?.approvalSource !== undefined) {
        updates.approvalSource = options.approvalSource;
      }
      if (options?.approvalReason !== undefined) {
        updates.approvalReason = options.approvalReason;
      }
    }

    if (
      (task.status === 'blocked' && (newStatus === 'open' || newStatus === 'in_progress')) ||
      (task.status === 'cancelled' && (newStatus === 'open' || newStatus === 'in_progress')) ||
      (task.status === 'done' && newStatus === 'in_progress') ||
      (task.status === 'in_progress' && newStatus === 'open') ||
      (task.status === 'review' && newStatus === 'in_progress')
    ) {
      updates.result = null;
      updates.reportedSummary = null;
      updates.blockReason = null;
      updates.approvalSource = null;
      updates.approvalReason = null;
      updates.approvedAt = null;
      updates.postApprovalSourceNodeId = null;
    }

    if (task.status === 'stopped' && newStatus === 'open') {
      updates.reportedStatus = null;
    }

    if (
      (task.status === 'review' && newStatus !== 'review' && newStatus !== 'stopped') ||
      newStatus === 'approved'
    ) {
      updates.pendingCheckpointType = null;
      updates.pendingCompletionSubmittedByNodeId = null;
      updates.pendingCompletionSubmittedAt = null;
      updates.pendingCompletionReason = null;
    }

    if (
      task.status === 'review' &&
      newStatus !== 'review' &&
      newStatus !== 'approved' &&
      newStatus !== 'stopped'
    ) {
      updates.postApprovalSourceNodeId = null;
    }

    if (task.status === 'approved' && newStatus !== 'approved') {
      updates.postApprovalSessionId = null;
      updates.postApprovalStartedAt = null;
      updates.postApprovalBlockedReason = null;
      updates.postApprovalSourceNodeId = null;
    }

    const updated = this.taskRepo.updateTask(taskId, updates);
    if (!updated) {
      throw new Error(`Failed to update task: ${taskId}`);
    }

    if (newStatus === 'done') {
      try {
        this.evolutionScopeService?.captureCompletedTaskEvidence({ taskId });
      } catch (err) {
        log.warn(
          `Forge evidence capture threw for task "${taskId}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
      try {
        const unblocked = await this.unblockDependentTasks(taskId);
        if (unblocked.length > 0 && options?.onCascadedTasks) {
          await options.onCascadedTasks(unblocked);
        }
      } catch {
        // Best-effort: unblock failures must not roll back the
        // already-committed done transition. The tick loop will
        // re-evaluate blocked dependents on the next cycle.
      }
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
    return this.setTaskStatus(taskId, 'open');
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

    const updated = this.taskRepo.updateTask(taskId, {
      status: 'review',
      pendingCheckpointType: 'task_completion',
      pendingCompletionSubmittedByNodeId: opts.submittedByNodeId,
      pendingCompletionSubmittedAt: Date.now(),
      pendingCompletionReason: opts.reason,
      blockReason: null,
      postApprovalSourceNodeId: opts.submittedByNodeId,
    });
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

  async updateTask(
    taskId: string,
    params: UpdateSpaceTaskParams,
    options?: {
      onCascadedTasks?: (cascaded: SpaceTask[]) => Promise<void>;
    }
  ): Promise<SpaceTask> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (params.status !== undefined && params.status !== task.status) {
      throw new Error('Use setTaskStatus to change task status — it enforces valid transitions');
    }

    if (params.dependsOn !== undefined) {
      await this.validateDependencyIds(params.dependsOn, taskId);
    }

    const depsChanged =
      params.dependsOn !== undefined && !arraysEqual(task.dependsOn ?? [], params.dependsOn);

    const { status: _status, ...repoParams } = params;
    const updated = this.taskRepo.updateTask(taskId, repoParams);
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
        } catch {
          // Per-dependent: a concurrent status change (e.g. archive)
          // can make blocked→open invalid. Skip this dependent and
          // continue with the rest rather than aborting the cascade.
        }
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
      const adj = new Map<string, string[]>();
      for (const t of allTasks) {
        if (t.id === taskId) {
          adj.set(t.id, [...depIds]);
        } else {
          adj.set(t.id, [...(t.dependsOn ?? [])]);
        }
      }
      if (this.hasCycle(adj)) {
        throw new Error('Adding these dependencies would create a circular dependency');
      }
    }
  }

  private hasCycle(adj: Map<string, string[]>): boolean {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    for (const id of adj.keys()) {
      color.set(id, WHITE);
    }

    const dfs = (node: string): boolean => {
      color.set(node, GRAY);
      for (const neighbor of adj.get(node) ?? []) {
        const c = color.get(neighbor);
        if (c === GRAY) return true;
        if (c === WHITE && dfs(neighbor)) return true;
      }
      color.set(node, BLACK);
      return false;
    };

    for (const id of adj.keys()) {
      if (color.get(id) === WHITE && dfs(id)) return true;
    }
    return false;
  }
}
