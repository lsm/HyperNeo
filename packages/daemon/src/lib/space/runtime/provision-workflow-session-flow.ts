import type { NodeExecution, Space, SpaceTask, SpaceWorkflowRun } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { AgentSession } from '../../agent/agent-session.ts';
import { isCanonicalTaskTerminalForSpawn } from '../../workflows/run-spawn-decisions.ts';

export interface ProvisioningOptions {
  startQuery?: boolean;
  replayPendingMessages?: boolean;
  onReplaySettled?: (succeeded: boolean) => void;
}

export interface ProvisioningRequest {
  taskId: string;
  sessionId: string;
  session: AgentSession;
  options: ProvisioningOptions;
}

export interface ProvisioningOwner {
  request: ProvisioningRequest;
  task: SpaceTask | null;
  workflowRun: SpaceWorkflowRun | null;
  space: Space | null;
}

export interface ProvisioningFacts {
  request: ProvisioningRequest;
  task: SpaceTask;
  workflowRun: SpaceWorkflowRun;
  space: Space;
  arm: 'post_approval' | 'rehydrate';
}

export type ProvisioningSkipReason =
  | 'archived_session'
  | 'ineligible'
  | 'post_approval_not_active'
  | 'missing_execution'
  | 'non_resumable_execution';

export type ProvisioningOutcome = ProvisioningFacts | ProvisioningSkipReason;

export interface ProvisioningFlowDeps {
  getTask(taskId: string): SpaceTask | null;
  getWorkflowRun(workflowRunId: string): SpaceWorkflowRun | null;
  getSpace(spaceId: string): Promise<Space | null>;
  resolveNodeExecution(sessionId: string): NodeExecution | null;
  hasQueuedRetryableHookAction(workflowRunId: string, execution: NodeExecution): boolean;
  readPersistedRateLimitCooldown(sessionId: string): { retryAt: number } | null;
  restorePostApprovalWorkerSession(
    taskId: string,
    sessionId: string,
    session: AgentSession | undefined,
    options: ProvisioningOptions
  ): Promise<unknown>;
  rehydrateSubSession(
    sessionId: string,
    session: AgentSession | undefined,
    options: ProvisioningOptions
  ): Promise<unknown>;
}

export async function resolveProvisioningOwner(
  getTask: ProvisioningFlowDeps['getTask'],
  getWorkflowRun: ProvisioningFlowDeps['getWorkflowRun'],
  getSpace: ProvisioningFlowDeps['getSpace'],
  request: ProvisioningRequest
): Promise<ProvisioningOwner> {
  const task = getTask(request.taskId) ?? null;
  const workflowRun = task?.workflowRunId ? (getWorkflowRun(task.workflowRunId) ?? null) : null;
  const space = task ? await getSpace(task.spaceId) : null;
  return { request, task, workflowRun, space };
}

export function admitWorkflowProvisioning(
  resolveNodeExecution: ProvisioningFlowDeps['resolveNodeExecution'],
  hasQueuedRetryableHookAction: ProvisioningFlowDeps['hasQueuedRetryableHookAction'],
  owner: ProvisioningOwner
): { value: ProvisioningFacts } | { reason: ProvisioningSkipReason } {
  const { request, task, workflowRun, space } = owner;
  if (request.session.getSessionData().status === 'archived') {
    return { reason: 'archived_session' };
  }
  if (
    !task?.workflowRunId ||
    !workflowRun ||
    workflowRun.status === 'cancelled' ||
    !space ||
    space.stopped ||
    space.paused ||
    space.status === 'archived'
  ) {
    return { reason: 'ineligible' };
  }
  if (request.sessionId.includes(':post-approval:')) {
    if (task.status !== 'approved') return { reason: 'post_approval_not_active' };
    return { value: { request, task, workflowRun, space, arm: 'post_approval' } };
  }
  if (isCanonicalTaskTerminalForSpawn(task.status) || workflowRun.status === 'done') {
    return { reason: 'ineligible' };
  }
  const execution = resolveNodeExecution(request.sessionId);
  if (!execution) return { reason: 'missing_execution' };
  if (
    execution.status !== 'in_progress' &&
    execution.status !== 'blocked' &&
    !hasQueuedRetryableHookAction(execution.workflowRunId, execution)
  ) {
    return { reason: 'non_resumable_execution' };
  }
  return { value: { request, task, workflowRun, space, arm: 'rehydrate' } };
}

export function selectProvisioningArm(facts: ProvisioningFacts): {
  provisioning: ProvisioningFacts;
  postApprovalArm: typeof restorePostApprovalWorkerStage | undefined;
  rehydrateArm: typeof rehydrateExecutionStage | undefined;
} {
  return {
    provisioning: facts,
    postApprovalArm: facts.arm === 'post_approval' ? restorePostApprovalWorkerStage : undefined,
    rehydrateArm: facts.arm === 'rehydrate' ? rehydrateExecutionStage : undefined,
  };
}

export async function restorePostApprovalWorkerStage(
  restorePostApprovalWorkerSession: ProvisioningFlowDeps['restorePostApprovalWorkerSession'],
  readPersistedRateLimitCooldown: ProvisioningFlowDeps['readPersistedRateLimitCooldown'],
  facts: ProvisioningFacts
): Promise<ProvisioningFacts> {
  const { request } = facts;
  const options = readPersistedRateLimitCooldown(request.sessionId)
    ? { ...request.options, startQuery: false }
    : request.options;
  await restorePostApprovalWorkerSession(
    request.taskId,
    request.sessionId,
    request.session,
    options
  );
  return facts;
}

export async function rehydrateExecutionStage(
  rehydrateSubSession: ProvisioningFlowDeps['rehydrateSubSession'],
  readPersistedRateLimitCooldown: ProvisioningFlowDeps['readPersistedRateLimitCooldown'],
  facts: ProvisioningFacts
): Promise<ProvisioningFacts> {
  const { request } = facts;
  const options = readPersistedRateLimitCooldown(request.sessionId)
    ? { ...request.options, startQuery: false }
    : request.options;
  await rehydrateSubSession(request.sessionId, request.session, options);
  return facts;
}

export function runProvisionWorkflowSessionFlow(
  deps: ProvisioningFlowDeps,
  request: ProvisioningRequest
): Promise<ProvisioningOutcome> {
  const run = (
    superpipe({
      tasks: deps.getTask,
      workflowRuns: deps.getWorkflowRun,
      spaces: deps.getSpace,
      resolveExecution: deps.resolveNodeExecution,
      queuedRetryableHook: deps.hasQueuedRetryableHookAction,
      readCooldown: deps.readPersistedRateLimitCooldown,
      restorePostApproval: deps.restorePostApprovalWorkerSession,
      rehydrate: deps.rehydrateSubSession,
    })('provision-workflow-session') as PipelineAPI
  )
    .input('request')
    .pipe(resolveProvisioningOwner, ['tasks', 'workflowRuns', 'spaces', 'request'], 'owner')
    .pipe(
      admitWorkflowProvisioning,
      ['resolveExecution', 'queuedRetryableHook', 'owner'],
      'result:provisioning'
    )
    .pipe(selectProvisioningArm, 'provisioning', [
      'provisioning',
      'postApprovalArm',
      'rehydrateArm',
    ])
    .pipe(
      '?postApprovalArm',
      ['restorePostApproval', 'readCooldown', 'provisioning'],
      'provisioning'
    )
    .pipe('?rehydrateArm', ['rehydrate', 'readCooldown', 'provisioning'], 'provisioning')
    .endAsync('provisioning') as (request: ProvisioningRequest) => Promise<ProvisioningOutcome>;
  return run(request);
}
