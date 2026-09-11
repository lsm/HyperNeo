export const AUTONOMY_LABELS: Record<number, string> = {
  1: 'Supervised',
  2: 'Semi-auto',
  3: 'Autonomous',
  4: 'Full auto',
  5: 'Unrestricted',
};

export function toolPermissionsToolsList(owner: {
  toolPermissions: Record<string, unknown>;
}): string[] {
  const tools = owner.toolPermissions?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.filter((tool): tool is string => typeof tool === 'string');
}
