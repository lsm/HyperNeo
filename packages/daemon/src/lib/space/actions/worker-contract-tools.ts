import type { SpaceMcpSessionRole } from '../runtime/space-mcp-session-policy.ts';
import { GENERAL_HOT_ACTIONS, ROLE_HOT_ACTIONS } from './description-generator.ts';

export const WORKER_NODE_HOT_FILL = [
  'node.peers.list',
  'node.reachableAgents.list',
  'node.channels.list',
  'send_message',
  'nodeAgent.restore',
] as const;

export interface RoleHotActionView {
  label: string;
  hotActions: readonly string[];
}

function displayLabel(value: string): string {
  return value
    .split('_')
    .map((part) => (part === 'qa' ? 'QA' : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
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

export function buildWorkerDispatcherContractTools(
  nodeRole?: string | null,
  availableActionNames?: ReadonlySet<string> | null
): string[] {
  const { label, hotActions } = resolveRoleHotActionView('workflow_worker', nodeRole);
  const suggested = [...hotActions, ...WORKER_NODE_HOT_FILL]
    .filter((name) => availableActionNames?.has(name) ?? false)
    .map((name) => `invoke(name="${name}")`);
  return [
    `  - invoke({ name, input? }) on the operations server — one door for every operation available to the ${label} role`,
    ...(suggested.length > 0 ? [`    Suggested: ${suggested.join(', ')}`] : []),
    '  - invoke(name="operations.list") — the authoritative catalog for this role; invoke(name="operations.describe") for one operation\'s schema',
  ];
}
