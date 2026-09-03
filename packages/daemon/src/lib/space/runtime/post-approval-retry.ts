import type { Space, SpaceTask, SpaceWorkflowRun } from '@hyperneo/shared';
import { isWorkflowRunSucceeded } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import {
  mapPostApprovalDispatchWarning,
  type PostApprovalRouteResult,
} from './post-approval-router.ts';

export interface PostApprovalRetryDeps {
  taskRepo: Pick<SpaceTaskRepository, 'getTask' | 'updateTask'>;
  workflowRunRepo: { getRun(runId: string): SpaceWorkflowRun | null };
  spaceManager: { getSpace(spaceId: string): Promise<Space | null> };
  dispatch: (
    taskId: string,
    approvalSource: NonNullable<SpaceTask['approvalSource']>
  ) => Promise<PostApprovalRouteResult>;
}

export interface PostApprovalRetryCtx extends PostApprovalRetryDeps {
  taskId: string;
  task: SpaceTask | null;
  result: PostApprovalRouteResult | null;
  halt: string | null;
}

function halted(ctx: PostApprovalRetryCtx, reason: string): PostApprovalRetryCtx {
  return { ...ctx, halt: reason };
}

export function applyLoadTask(ctx: PostApprovalRetryCtx): PostApprovalRetryCtx {
  const task = ctx.taskRepo.getTask(ctx.taskId);
  if (!task) return halted(ctx, `post-approval retry: task ${ctx.taskId} not found`);
  return { ...ctx, task };
}

export function applyRetryEligibility(ctx: PostApprovalRetryCtx): PostApprovalRetryCtx {
  const task = ctx.task;
  if (!task) return ctx;
  if (task.status !== 'approved') {
    return halted(ctx, `post-approval retry: task ${task.id} is ${task.status}, not approved`);
  }
  if (!task.postApprovalBlockedReason) {
    return halted(ctx, `post-approval retry: task ${task.id} has no blocked dispatch to retry`);
  }
  if (!task.workflowRunId) {
    return halted(
      ctx,
      `post-approval retry: task ${task.id} is not bound to a workflow run; nothing to retry`
    );
  }
  return ctx;
}

export function applyRunEligibility(ctx: PostApprovalRetryCtx): PostApprovalRetryCtx {
  const task = ctx.task;
  if (!task?.workflowRunId) return ctx;
  const run = ctx.workflowRunRepo.getRun(task.workflowRunId);
  if (!run || !isWorkflowRunSucceeded(run.status)) {
    return halted(
      ctx,
      `post-approval retry: workflow run ${task.workflowRunId} for task ${task.id} is ${run?.status ?? 'missing'}, not a completed run`
    );
  }
  return ctx;
}

export async function applySpaceEligibility(
  ctx: PostApprovalRetryCtx
): Promise<PostApprovalRetryCtx> {
  const task = ctx.task;
  if (!task) return ctx;
  const space = await ctx.spaceManager.getSpace(task.spaceId);
  if (!space || space.paused || space.stopped || space.status === 'archived') {
    return halted(
      ctx,
      `post-approval retry: space ${task.spaceId} for task ${task.id} is ${space?.status ?? 'missing'}${space?.paused ? ' (paused)' : ''}${space?.stopped ? ' (stopped)' : ''}`
    );
  }
  return ctx;
}

export async function applyDispatch(ctx: PostApprovalRetryCtx): Promise<PostApprovalRetryCtx> {
  const task = ctx.task;
  if (!task) return ctx;
  try {
    const result = await ctx.dispatch(task.id, task.approvalSource ?? 'agent');
    return { ...ctx, result };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const fresh = ctx.taskRepo.getTask(task.id);
    if (
      fresh?.status === 'approved' &&
      fresh.workflowRunId === task.workflowRunId &&
      fresh.approvedAt === task.approvedAt &&
      fresh.postApprovalSessionId === task.postApprovalSessionId
    ) {
      ctx.taskRepo.updateTask(task.id, {
        postApprovalBlockedReason: mapPostApprovalDispatchWarning(detail),
      });
    }
    return { ...ctx, result: { mode: 'skipped', reason: detail } };
  }
}

const postApprovalRetryRun = (
  superpipe<{ halted: (ctx: PostApprovalRetryCtx) => boolean }>({
    halted: (ctx: PostApprovalRetryCtx): boolean => ctx.halt !== null,
  })('post-approval-retry') as PipelineAPI
)
  .input(['ctx'])
  .pipe(applyLoadTask, 'ctx', 'ctx')
  .pipe('!halted', 'ctx')
  .pipe(applyRetryEligibility, 'ctx', 'ctx')
  .pipe('!halted', 'ctx')
  .pipe(applyRunEligibility, 'ctx', 'ctx')
  .pipe('!halted', 'ctx')
  .pipe(applySpaceEligibility, 'ctx', 'ctx')
  .pipe('!halted', 'ctx')
  .pipe(applyDispatch, 'ctx', 'ctx')
  .endAsync('ctx');

export async function runPostApprovalRetry(
  input: PostApprovalRetryDeps & { taskId: string }
): Promise<PostApprovalRouteResult> {
  const ctx = (await postApprovalRetryRun({
    ...input,
    task: null,
    result: null,
    halt: null,
  })) as PostApprovalRetryCtx;
  if (ctx.halt !== null) return { mode: 'skipped', reason: ctx.halt };
  return ctx.result ?? { mode: 'skipped', reason: 'post-approval retry produced no result' };
}

export class TaskScopedRetrySerializer {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  run<T>(taskId: string, op: () => Promise<T>): Promise<T> {
    const prior = this.inFlight.get(taskId) ?? Promise.resolve();
    const settled = prior.catch(() => {});
    const attempt = settled.then(op);
    const stored = attempt.catch(() => {});
    this.inFlight.set(taskId, stored);
    const cleanup = () => {
      if (this.inFlight.get(taskId) === stored) this.inFlight.delete(taskId);
    };
    attempt.then(cleanup, cleanup);
    return attempt;
  }
}
