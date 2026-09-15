import { z } from 'zod';
import type { OperationRegistrySource } from '../../operations/registry.ts';
import type { SpaceMcpSessionRole } from '../runtime/space-mcp-session-policy.ts';
import { hasSpaceAuthority } from '../runtime/space-mcp-session-policy.ts';
import type { NodeAgentToolsConfig } from './node-handlers.ts';
import type { ActionDefinition, ActionRegistry, RegisteredAction } from './registry.ts';
import { createActionRegistry, defineAction } from './registry.ts';
import { composeRoleActionEntries, createNodeRegistryEntries } from './registry-node.ts';
import { createSpaceRegistryEntries } from './registry-space.ts';
import type { SpaceAgentToolsConfig } from './space-handlers.ts';

export const SPACE_AUTHORITY_ONLY_ACTIONS = new Set(['approve_pending_completion']);

export const DISPATCHABLE_ROLES: ReadonlySet<SpaceMcpSessionRole> = new Set([
  'ad_hoc_member',
  'workflow_worker',
  'long_term_agent',
  'universal_read',
]);

export interface SessionActionRegistryConfig {
  readonly role: SpaceMcpSessionRole;
  readonly spaceId: string;
  readonly deniedActionNames?: ReadonlySet<string>;
  readonly spaceConfig?: SpaceAgentToolsConfig;
  readonly nodeConfig?: NodeAgentToolsConfig;
  readonly operationRegistry?: OperationRegistrySource;
}

export function actionSummary(action: RegisteredAction) {
  return {
    name: action.name,
    family: action.family,
    safetyClass: action.safetyClass,
    description: action.description,
  };
}

export function createRegistryMetaEntries(getRegistry: () => ActionRegistry): ActionDefinition[] {
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

export function assertDispatchableSessionConfig(config: SessionActionRegistryConfig): void {
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
}

export function createSessionActionRegistry(config: SessionActionRegistryConfig): ActionRegistry {
  assertDispatchableSessionConfig(config);
  const spaceConfig = config.spaceConfig
    ? { ...config.spaceConfig, callerRole: config.role }
    : undefined;
  const spaceEntries = spaceConfig
    ? createSpaceRegistryEntries(spaceConfig, config.operationRegistry)
    : [];
  const nodeEntries = config.nodeConfig
    ? createNodeRegistryEntries(config.nodeConfig, config.operationRegistry)
    : [];
  const isRoleAdmittedEntry = (entry: ActionDefinition) =>
    hasSpaceAuthority(spaceConfig?.callerRole) || !SPACE_AUTHORITY_ONLY_ACTIONS.has(entry.name);
  const isNotDeniedEntry = (entry: ActionDefinition) => !config.deniedActionNames?.has(entry.name);
  const isUniversalReadFiltered = (entry: ActionDefinition) =>
    config.role !== 'universal_read' || entry.safetyClass === 'read';
  let registry: ActionRegistry;
  const metaEntries = createRegistryMetaEntries(() => registry);
  registry = createActionRegistry([
    ...composeRoleActionEntries(config.role, spaceEntries, nodeEntries)
      .filter(isRoleAdmittedEntry)
      .filter(isNotDeniedEntry)
      .filter(isUniversalReadFiltered),
    ...metaEntries,
  ]);
  return registry;
}
