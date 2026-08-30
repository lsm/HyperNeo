import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SpaceMcpSessionRole } from '../runtime/space-mcp-session-policy.ts';
import type { NodeAgentToolsConfig } from '../tools/node-agent-tools.ts';
import type { SpaceAgentToolsConfig } from '../tools/space-agent-tools.ts';
import { jsonResult } from '../tools/tool-result.ts';
import {
  buildCallActionDescription,
  GENERAL_HOT_ACTIONS,
  ROLE_HOT_ACTIONS,
} from './description-generator.ts';
import {
  runDispatchAction,
  type DispatchActionDeps,
  type DispatchActionInput,
} from './dispatcher-pipeline.ts';
import {
  createRateAdmission,
  emitActionDispatchedEvent,
  resolveRateAdmissionOptions,
} from './dispatch-telemetry.ts';
import { composeRoleActionEntries, createNodeRegistryEntries } from './registry-node.ts';
import { createSpaceRegistryEntries } from './registry-space.ts';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository.ts';
import {
  createActionRegistry,
  defineAction,
  type ActionDefinition,
  type ActionRegistry,
  type RegisteredAction,
} from './registry.ts';

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

const COORDINATOR_ONLY_ACTIONS = new Set(['approve_pending_completion']);

const DISPATCHABLE_ROLES: ReadonlySet<SpaceMcpSessionRole> = new Set([
  'coordinator',
  'ad_hoc_member',
  'workflow_worker',
  'long_term_agent',
]);

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

function actionSummary(action: RegisteredAction) {
  return {
    name: action.name,
    family: action.family,
    safetyClass: action.safetyClass,
    description: action.description,
  };
}

function createRegistryMetaEntries(getRegistry: () => ActionRegistry): ActionDefinition[] {
  return [
    defineAction({
      name: 'list_actions',
      family: 'space',
      safetyClass: 'read',
      description: 'List every action registered for this role — the full action catalog.',
      paramsDoc: 'none',
      paramsSchema: z.object({}),
      returnsHint: 'the full action catalog for this role',
      handler: async () => getRegistry().entries.map(actionSummary),
    }),
    defineAction({
      name: 'describe_action',
      family: 'space',
      safetyClass: 'read',
      description: 'Describe one action: parameters, returns, and autonomy requirement.',
      paramsDoc: 'name: string',
      paramsSchema: z.object({ name: z.string() }),
      returnsHint: 'one action detail record',
      handler: async (params: { name: string }) => {
        const action = getRegistry().get(params.name);
        if (!action) return { error: `Unknown action: ${params.name}` };
        return {
          ...actionSummary(action),
          params: action.paramsDoc,
          returns: action.returnsHint ?? 'the action result',
          autonomyRequirement:
            action.autonomyRequirement === undefined
              ? 'none — available at every autonomy level'
              : typeof action.autonomyRequirement === 'number'
                ? action.autonomyRequirement
                : 'depends on the provided parameters',
        };
      },
    }),
  ];
}

export function isSpaceActionsDispatcherEnabled(): boolean {
  const v = process.env.HYPERNEO_SPACE_ACTIONS_DISPATCHER;
  return v === '1' || v === 'true';
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
}

export function createSpaceActionsMcpServer(config: SpaceActionsServerConfig) {
  if (!DISPATCHABLE_ROLES.has(config.role)) {
    throw new Error(
      `createSpaceActionsMcpServer does not support role "${config.role}": the dispatcher ` +
        'admits no action families for it, so no action (including list_actions) could ever run'
    );
  }
  if (config.spaceConfig && config.spaceConfig.spaceId !== config.spaceId) {
    throw new Error(
      `spaceConfig.spaceId "${config.spaceConfig.spaceId}" does not match server spaceId "${config.spaceId}"`
    );
  }
  if (config.nodeConfig && config.nodeConfig.spaceId !== config.spaceId) {
    throw new Error(
      `nodeConfig.spaceId "${config.nodeConfig.spaceId}" does not match server spaceId "${config.spaceId}"`
    );
  }
  const spaceConfig = config.spaceConfig
    ? { ...config.spaceConfig, callerRole: config.role }
    : undefined;
  const spaceEntries = spaceConfig ? createSpaceRegistryEntries(spaceConfig) : [];
  const nodeEntries = config.nodeConfig ? createNodeRegistryEntries(config.nodeConfig) : [];
  const isRoleAdmittedEntry = (entry: ActionDefinition) =>
    config.role === 'coordinator' || !COORDINATOR_ONLY_ACTIONS.has(entry.name);
  const isNotDeniedEntry = (entry: ActionDefinition) => !config.deniedActionNames?.has(entry.name);
  let registry: ActionRegistry;
  const metaEntries = createRegistryMetaEntries(() => registry);
  registry = createActionRegistry([
    ...composeRoleActionEntries(config.role, spaceEntries, nodeEntries)
      .filter(isRoleAdmittedEntry)
      .filter(isNotDeniedEntry),
    ...metaEntries,
  ]);

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
