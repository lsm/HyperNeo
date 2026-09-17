import type { OperationRegistrySource } from '../../operations/registry.ts';
import type { SpaceMcpSessionRole } from '../runtime/space-mcp-session-policy.ts';
import { ListArtifactsSchema, SaveArtifactSchema } from './node-agent-schemas.ts';
import { createNodeAgentToolHandlers, type NodeAgentToolsConfig } from './node-handlers.ts';
import { type ActionDefinition, type ActionEntry, defineAction } from './registry.ts';

function nodeAction<P>(entry: Omit<ActionEntry<P>, 'family'>): ActionDefinition {
  return defineAction({ ...entry, family: 'node' });
}

export function createNodeRegistryEntries(
  config: NodeAgentToolsConfig,
  _operations?: OperationRegistrySource
): ActionDefinition[] {
  const handlers = createNodeAgentToolHandlers({ ...config, disableAuditLogWrites: true });
  const { artifactRepo } = config;

  return [
    ...(artifactRepo
      ? [
          nodeAction({
            name: 'save_artifact',
            safetyClass: 'mutate',
            description:
              'Persist a structured fact to the run artifact store as one of link/commit_set/check/metric/decision/note.',
            paramsDoc: 'shape, kind?, key?, summary?, data?',
            auditRedactKeys: ['data'],
            paramsSchema: SaveArtifactSchema,
            handler: handlers.save_artifact,
          }),
          nodeAction({
            name: 'list_artifacts',
            safetyClass: 'read',
            description:
              'List artifacts for the current run, optionally filtered by nodeId or shape.',
            paramsDoc: 'nodeId?, type?',
            paramsSchema: ListArtifactsSchema,
            handler: handlers.list_artifacts,
          }),
        ]
      : []),
  ];
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
