import { AUTONOMY_LABELS as SPACE_AUTONOMY_LABELS } from '../../lib/space-constants';

export const AUTONOMY_LABELS: Record<number, string> = SPACE_AUTONOMY_LABELS;

export function toolPermissionsToolsList(owner: {
  toolPermissions: Record<string, unknown>;
}): string[] {
  const tools = owner.toolPermissions?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.filter((tool): tool is string => typeof tool === 'string');
}
