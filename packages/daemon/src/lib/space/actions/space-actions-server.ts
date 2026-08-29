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
import { runDispatchAction, type DispatchActionDeps } from './dispatcher-pipeline.ts';
import {
  createRateAdmission,
  emitActionDispatchedEvent,
  resolveRateAdmissionOptions,
} from './dispatch-telemetry.ts';
import { composeRoleActionEntries, createNodeRegistryEntries } from './registry-node.ts';
import { createSpaceRegistryEntries } from './registry-space.ts';
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
            typeof action.autonomyRequirement === 'number'
              ? action.autonomyRequirement
              : 'depends on the provided parameters',
        };
      },
    }),
  ];
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
  readonly spaceConfig?: SpaceAgentToolsConfig;
  readonly nodeConfig?: NodeAgentToolsConfig;
  readonly dispatchDeps?: Partial<Omit<DispatchActionDeps, 'registry'>>;
}

export function createSpaceActionsMcpServer(config: SpaceActionsServerConfig) {
  const spaceConfig = config.spaceConfig
    ? { ...config.spaceConfig, callerRole: config.role }
    : undefined;
  const spaceEntries = spaceConfig ? createSpaceRegistryEntries(spaceConfig) : [];
  const nodeEntries = config.nodeConfig ? createNodeRegistryEntries(config.nodeConfig) : [];
  let registry: ActionRegistry;
  const metaEntries = createRegistryMetaEntries(() => registry);
  registry = createActionRegistry([
    ...composeRoleActionEntries(config.role, spaceEntries, nodeEntries),
    ...metaEntries,
  ]);

  const { label, hotActions } = resolveRoleHotActionView(config.role, config.nodeRole);
  const description = buildCallActionDescription({
    role: label,
    spaceLevel: config.spaceLevel,
    agentCeiling: config.agentLevel,
    hotActions,
    registry,
  });

  const deps: DispatchActionDeps = {
    ...config.dispatchDeps,
    auditLogRepo:
      config.dispatchDeps?.auditLogRepo ??
      config.nodeConfig?.auditLogRepo ??
      spaceConfig?.auditLogRepo,
    getSpaceAutonomyLevel:
      config.dispatchDeps?.getSpaceAutonomyLevel ?? spaceConfig?.getSpaceAutonomyLevel,
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
      const outcome = await runDispatchAction(deps, {
        actionName: args.name,
        params: args.params ?? {},
        role: config.role,
        spaceId: config.spaceId,
        taskId: config.taskId ?? config.nodeConfig?.taskId ?? undefined,
        workflowRunId: config.workflowRunId ?? config.nodeConfig?.workflowRunId ?? undefined,
        agentName: config.agentName ?? config.nodeConfig?.myAgentName ?? spaceConfig?.myAgentName,
        sessionId: config.sessionId ?? config.nodeConfig?.mySessionId ?? spaceConfig?.mySessionId,
        spaceLevel: config.spaceLevel,
        agentLevel: config.agentLevel,
      });
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
