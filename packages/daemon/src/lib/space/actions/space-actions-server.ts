import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository.ts';
import type { OperationRegistrySource } from '../../operations/registry.ts';
import type { SpaceMcpSessionRole } from '../runtime/space-mcp-session-policy.ts';
import { jsonResult } from '../tools/tool-result.ts';
import {
  buildCallActionDescription,
  GENERAL_HOT_ACTIONS,
  ROLE_HOT_ACTIONS,
} from './description-generator.ts';
import {
  createRateAdmission,
  emitActionDispatchedEvent,
  resolveRateAdmissionOptions,
} from './dispatch-telemetry.ts';
import {
  type DispatchActionDeps,
  type DispatchActionInput,
  runDispatchAction,
} from './dispatcher-pipeline.ts';
import type { NodeAgentToolsConfig } from './node-handlers.ts';
import type { RegisteredAction } from './registry.ts';
import { createSessionActionRegistry } from './session-action-registry.ts';
import type { SpaceAgentToolsConfig } from './space-handlers.ts';

const CallActionParamsSchema = z.object({
  name: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const WORKER_NODE_HOT_FILL = [
  'list_peers',
  'list_reachable_agents',
  'list_channels',
  'send_message',
  'restore_node_agent',
] as const;

function displayLabel(value: string): string {
  return value
    .split('_')
    .map((part) => (part === 'qa' ? 'QA' : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

export interface RoleHotActionView {
  readonly label: string;
  readonly hotActions: readonly string[];
}

export function buildWorkerDispatcherContractTools(
  nodeRole?: string | null,
  availableActionNames?: ReadonlySet<string> | null
): string[] {
  const { label, hotActions } = resolveRoleHotActionView('workflow_worker', nodeRole);
  const suggested = [...hotActions, ...WORKER_NODE_HOT_FILL]
    .filter((name) => availableActionNames?.has(name) ?? false)
    .map((name) => `call_action(name="${name}")`);
  return [
    `  - call_action({ name, params? }) on the space-actions server — one dispatcher for every action available to the ${label} role`,
    ...(suggested.length > 0 ? [`    Suggested: ${suggested.join(', ')}`] : []),
    '  - call_action(name="list_actions") — the authoritative action catalog for this role; call_action(name="describe_action") for one action\'s params',
  ];
}

export function resolveRoleHotActionView(
  sessionRole: SpaceMcpSessionRole,
  nodeRole?: string | null
): RoleHotActionView {
  const key = typeof nodeRole === 'string' ? nodeRole.trim().toLowerCase() : '';
  const nodeHotActions = key ? ROLE_HOT_ACTIONS[key] : undefined;
  if (nodeHotActions) {
    return { label: displayLabel(key), hotActions: nodeHotActions };
  }
  return { label: displayLabel(sessionRole), hotActions: GENERAL_HOT_ACTIONS };
}

function explicitRunId(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const record = params as Record<string, unknown>;
  for (const key of ['run_id', 'workflow_run_id', 'workflowRunId']) {
    if (typeof record[key] === 'string' && record[key].length > 0) return record[key];
  }
  return undefined;
}

export interface SpaceActionsServerConfig {
  readonly role: SpaceMcpSessionRole;
  readonly nodeRole?: string | null;
  readonly spaceId: string;
  readonly taskId?: string | null;
  readonly workflowRunId?: string | null;
  readonly agentName?: string | null;
  readonly sessionId?: string | null;
  readonly spaceLevel?: number | null;
  readonly agentLevel?: number | null;
  readonly deniedActionNames?: ReadonlySet<string>;
  readonly workflowRunRepo?: Pick<SpaceWorkflowRunRepository, 'getRun'>;
  readonly spaceConfig?: SpaceAgentToolsConfig;
  readonly nodeConfig?: NodeAgentToolsConfig;
  readonly dispatchDeps?: Partial<Omit<DispatchActionDeps, 'registry'>>;
  readonly operationRegistry?: OperationRegistrySource;
}

export function createSpaceActionsMcpServer(config: SpaceActionsServerConfig) {
  const registry = createSessionActionRegistry(config);
  const spaceConfig = config.spaceConfig
    ? { ...config.spaceConfig, callerRole: config.role }
    : undefined;

  const resolveAgentLevel = (): number | null => {
    if (spaceConfig?.myAgentId && spaceConfig.longHorizonAgentRepo) {
      let record: { spaceId?: string; autonomyLevel?: number | null } | null = null;
      let lookupFailed = false;
      try {
        record = spaceConfig.longHorizonAgentRepo.getById(spaceConfig.myAgentId) as {
          spaceId?: string;
          autonomyLevel?: number | null;
        } | null;
      } catch {
        lookupFailed = true;
      }
      if (lookupFailed) return 1;
      if (record && record.spaceId === config.spaceId) return record.autonomyLevel ?? null;
      return 1;
    }
    if (config.agentLevel != null) return config.agentLevel;
    return config.role === 'long_term_agent' ? 1 : null;
  };

  const { label, hotActions } = resolveRoleHotActionView(config.role, config.nodeRole);
  const description = buildCallActionDescription({
    role: label,
    spaceLevel: config.spaceLevel,
    agentCeiling: resolveAgentLevel(),
    hotActions:
      config.role === 'workflow_worker' ? [...hotActions, ...WORKER_NODE_HOT_FILL] : hotActions,
    registry,
  });

  const taskRepo = spaceConfig?.taskRepo ?? config.nodeConfig?.taskRepo;
  const deps: DispatchActionDeps = {
    ...config.dispatchDeps,
    auditLogRepo:
      config.dispatchDeps?.auditLogRepo ??
      config.nodeConfig?.auditLogRepo ??
      spaceConfig?.auditLogRepo,
    getSpaceAutonomyLevel:
      config.dispatchDeps?.getSpaceAutonomyLevel ?? spaceConfig?.getSpaceAutonomyLevel,
    auditReads: config.dispatchDeps?.auditReads ?? true,
    resolveTaskId:
      config.dispatchDeps?.resolveTaskId ??
      (taskRepo
        ? (params) => {
            const taskNumber = params.task_number;
            if (typeof taskNumber !== 'number') return undefined;
            return taskRepo.getTaskByNumber(config.spaceId, taskNumber)?.id ?? undefined;
          }
        : undefined),
    resolveRunId:
      config.dispatchDeps?.resolveRunId ??
      (taskRepo
        ? (taskId) => {
            const task = taskRepo.getTask(taskId);
            return task && task.spaceId === config.spaceId
              ? (task.workflowRunId ?? undefined)
              : undefined;
          }
        : undefined),
    validateTargets:
      config.dispatchDeps?.validateTargets ??
      ((params: unknown, spaceId: string, action?: RegisteredAction) => {
        if (typeof params !== 'object' || params === null) return undefined;
        const record = params as Record<string, unknown>;
        const runId = explicitRunId(record);
        const runRepo = spaceConfig?.workflowRunRepo ?? config.workflowRunRepo;
        if (runId && runRepo) {
          const run = runRepo.getRun(runId);
          if (run && run.spaceId !== spaceId) {
            return `Workflow run ${runId} does not belong to space ${spaceId}`;
          }
        }
        const prefersTaskNumber =
          action?.taskIdPreference === 'task_number' && typeof record.task_number === 'number';
        if (
          !prefersTaskNumber &&
          typeof record.task_id === 'string' &&
          record.task_id.length > 0 &&
          taskRepo
        ) {
          const task = taskRepo.getTask(record.task_id);
          if (task && task.spaceId !== spaceId) {
            return `Task ${record.task_id} does not belong to space ${spaceId}`;
          }
        }
        return undefined;
      }),
    registry,
    emitTelemetry: config.dispatchDeps?.emitTelemetry ?? emitActionDispatchedEvent,
    isWithinRateBudget:
      config.dispatchDeps?.isWithinRateBudget ?? createRateAdmission(resolveRateAdmissionOptions()),
  };

  const callActionTool = tool(
    'call_action',
    description,
    CallActionParamsSchema.shape,
    async (args) => {
      const dispatchInput: DispatchActionInput = {
        actionName: args.name,
        params: args.params ?? {},
        role: config.role,
        spaceId: config.spaceId,
        taskId: config.taskId ?? config.nodeConfig?.taskId ?? undefined,
        workflowRunId: config.workflowRunId ?? config.nodeConfig?.workflowRunId ?? undefined,
        agentName: config.agentName ?? config.nodeConfig?.myAgentName ?? spaceConfig?.myAgentName,
        sessionId: config.sessionId ?? config.nodeConfig?.mySessionId ?? spaceConfig?.mySessionId,
        spaceLevel: deps.getSpaceAutonomyLevel ? null : config.spaceLevel,
        agentLevel: resolveAgentLevel(),
      };
      const outcome = await runDispatchAction(deps, dispatchInput);
      if (outcome.action === 'dispatched') return outcome.result;
      if (outcome.action === 'denied') {
        return jsonResult({
          error: 'action_denied',
          reason: outcome.reason,
          message: outcome.message,
        });
      }
      return jsonResult({ error: 'action_failed', message: outcome.error });
    }
  );

  const server = createSdkMcpServer({ name: 'space-actions', tools: [callActionTool] });
  return { ...server, tools: [callActionTool], registry, description, deps };
}

export type SpaceActionsMcpServer = ReturnType<typeof createSpaceActionsMcpServer>;
