import type { OperationRegistrySource } from '../../operations/registry.ts';
import type { SpaceMcpSessionRole } from '../runtime/space-mcp-session-policy.ts';
import type { NodeAgentToolsConfig } from './node-handlers.ts';
import type { ActionDefinition } from './registry.ts';

export function createNodeRegistryEntries(
  _config: NodeAgentToolsConfig,
  _operations?: OperationRegistrySource
): ActionDefinition[] {
  return [];
}

const WORKER_SPACE_ACTION_ALLOWLIST = new Set([
  'get_external_event',
  'get_workflow_detail',
  'get_workflow_run',
  'inactivity_config_get',
  'list_workflows',
  'suggest_workflow',
]);

export function composeRoleActionEntries(
  role: SpaceMcpSessionRole,
  spaceEntries: readonly ActionDefinition[],
  nodeEntries: readonly ActionDefinition[]
): ActionDefinition[] {
  const workerOnlyNodeNames = new Set(['approve_task', 'submit_for_approval', 'mark_complete']);
  const withSpaceFamily = (entry: ActionDefinition) => ({ ...entry, family: 'space' as const });

  if (role !== 'workflow_worker') {
    return spaceEntries.map(withSpaceFamily);
  }

  const nodeNames = new Set(nodeEntries.map((entry) => entry.name));
  const isWorkerSpaceAllowed = (entry: ActionDefinition) =>
    WORKER_SPACE_ACTION_ALLOWLIST.has(entry.name) && !workerOnlyNodeNames.has(entry.name);

  return [
    ...nodeEntries,
    ...spaceEntries
      .filter((entry) => !nodeNames.has(entry.name) && isWorkerSpaceAllowed(entry))
      .map(withSpaceFamily),
  ];
}
