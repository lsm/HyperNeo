import type { SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import {
  mapPostApprovalDispatchWarning,
  type PostApprovalRouteResult,
} from '../runtime/post-approval-router.ts';
import type { ToolResult } from './tool-result.ts';
import { jsonResult } from './tool-result.ts';

export type EndNodeApprovalHalt = 'resolved' | 'completion_pipeline';

export interface EndNodeApprovalDispatchFence {
  expectedStatus: SpaceTask['status'];
  expectedCheckpointAt: number | null;
}

export interface EndNodeApprovalDeps {
  taskId: string;
  taskRepo: Pick<SpaceTaskRepository, 'getTask' | 'updateTask'>;
  dispatchApproval: (fence: EndNodeApprovalDispatchFence) => Promise<PostApprovalRouteResult>;
  emitTaskUpdated: (task: SpaceTask) => void;
}

export interface EndNodeApprovalCtx extends EndNodeApprovalDeps {
  task: SpaceTask | null;
  routeResult: PostApprovalRouteResult | null;
  dispatchError: string | null;
  response: ToolResult | null;
  halt: EndNodeApprovalHalt | null;
}

export type EndNodeApprovalRun =
  | { action: 'respond'; response: ToolResult }
  | { action: 'completion_pipeline' };

export function applyLoadTask(ctx: EndNodeApprovalCtx): EndNodeApprovalCtx {
  const task = ctx.taskRepo.getTask(ctx.taskId);
  if (!task) {
    return {
      ...ctx,
      halt: 'resolved',
      response: jsonResult({ success: false, error: `Task not found: ${ctx.taskId}` }),
    };
  }
  return { ...ctx, task };
}

export function applyStatusAdmission(ctx: EndNodeApprovalCtx): EndNodeApprovalCtx {
  const task = ctx.task;
  if (!task) return ctx;
  if (task.status === 'done' || task.status === 'cancelled' || task.status === 'archived') {
    return {
      ...ctx,
      halt: 'resolved',
      response: jsonResult({
        success: false,
        taskId: task.id,
        error: `Task is already '${task.status}' — approval does not apply.`,
      }),
    };
  }
  if (task.status !== 'review' && task.status !== 'approved') {
    return { ...ctx, halt: 'completion_pipeline' };
  }
  return ctx;
}

function shouldRecordBlockedFailure(task: SpaceTask, fresh: SpaceTask): boolean {
  if (fresh.status !== 'approved') return false;
  if (fresh.postApprovalSessionId != null) return false;
  if (fresh.postApprovalBlockedReason != null) return false;
  if (task.status === 'review') return true;
  return fresh.approvedAt === task.approvedAt && fresh.workflowRunId === task.workflowRunId;
}

function recordBlockedWarning(ctx: EndNodeApprovalCtx, detail: string): void {
  const task = ctx.task!;
  const fresh = ctx.taskRepo.getTask(task.id);
  if (!fresh || !shouldRecordBlockedFailure(task, fresh)) return;
  const updated = ctx.taskRepo.updateTask(task.id, {
    postApprovalBlockedReason: mapPostApprovalDispatchWarning(detail),
  });
  if (updated) ctx.emitTaskUpdated(updated);
}

export async function applyDispatch(ctx: EndNodeApprovalCtx): Promise<EndNodeApprovalCtx> {
  const task = ctx.task;
  if (!task) return ctx;
  try {
    const routeResult = await ctx.dispatchApproval({
      expectedStatus: task.status,
      expectedCheckpointAt: task.pendingCompletionSubmittedAt ?? null,
    });
    if (routeResult.mode === 'skipped') {
      recordBlockedWarning(ctx, routeResult.reason);
    }
    return { ...ctx, routeResult };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordBlockedWarning(ctx, detail);
    return { ...ctx, dispatchError: detail };
  }
}

export function applyReportStamp(ctx: EndNodeApprovalCtx): EndNodeApprovalCtx {
  const task = ctx.task;
  if (!task) return ctx;
  const fresh = ctx.taskRepo.getTask(task.id);
  if (!fresh || fresh.workflowRunId !== task.workflowRunId) return ctx;
  const generationCurrent =
    fresh.status === 'approved' ||
    fresh.status === 'done' ||
    (fresh.status === 'review' &&
      fresh.pendingCompletionSubmittedAt === task.pendingCompletionSubmittedAt);
  if (!generationCurrent) return ctx;
  const stamped = ctx.taskRepo.updateTask(task.id, { reportedStatus: 'done' });
  if (stamped) ctx.emitTaskUpdated(stamped);
  return ctx;
}

export function mapApprovalRouteResponse(
  result: PostApprovalRouteResult,
  taskId: string
): ToolResult {
  if (result.mode === 'skipped') {
    return jsonResult({
      success: false,
      taskId,
      error: `Approval dispatch skipped: ${result.reason}`,
    });
  }
  const message =
    result.mode === 'no-route'
      ? 'Task approved and completed (no post-approval route). Task transitioned to done.'
      : result.mode === 'already-routed'
        ? 'Task approved. The post-approval session is already running — finish it and call mark_complete when done.'
        : 'Task approved. Post-approval work dispatched — finish it and call mark_complete when done.';
  return jsonResult({ success: true, taskId, message });
}

export function applyRespond(ctx: EndNodeApprovalCtx): EndNodeApprovalCtx {
  const task = ctx.task;
  if (!task) return ctx;
  if (ctx.dispatchError !== null) {
    return {
      ...ctx,
      halt: 'resolved',
      response: jsonResult({ success: false, taskId: task.id, error: ctx.dispatchError }),
    };
  }
  const result = ctx.routeResult ?? { mode: 'skipped' as const, reason: 'no dispatch result' };
  return { ...ctx, halt: 'resolved', response: mapApprovalRouteResponse(result, task.id) };
}

const endNodeApprovalRun = (
  superpipe<{ halted: (ctx: EndNodeApprovalCtx) => boolean }>({
    halted: (ctx: EndNodeApprovalCtx): boolean => ctx.halt !== null,
  })('end-node-approval') as PipelineAPI
)
  .input(['ctx'])
  .pipe(applyLoadTask, 'ctx', 'ctx')
  .pipe('!halted', 'ctx')
  .pipe(applyStatusAdmission, 'ctx', 'ctx')
  .pipe('!halted', 'ctx')
  .pipe(applyDispatch, 'ctx', 'ctx')
  .pipe(applyReportStamp, 'ctx', 'ctx')
  .pipe(applyRespond, 'ctx', 'ctx')
  .endAsync('ctx');

export async function runEndNodeApproval(input: EndNodeApprovalDeps): Promise<EndNodeApprovalRun> {
  const ctx = (await endNodeApprovalRun({
    ...input,
    task: null,
    routeResult: null,
    dispatchError: null,
    response: null,
    halt: null,
  })) as EndNodeApprovalCtx;
  if (ctx.halt === 'completion_pipeline') return { action: 'completion_pipeline' };
  return {
    action: 'respond',
    response:
      ctx.response ?? jsonResult({ success: false, error: 'approval produced no response' }),
  };
}
