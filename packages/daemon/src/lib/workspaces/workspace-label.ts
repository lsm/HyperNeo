import { isAbsolute } from 'node:path';
import type { SpaceWorkspaceRecord } from '../../storage/repositories/space-workspace-repository.ts';

export function admitWorkspaceLabel(
  label: string | undefined,
  siblings: readonly SpaceWorkspaceRecord[],
  workspaceId?: string
): { value: string } | { reason: string } {
  const value = (label ?? '').trim();
  if (value === '') return { value };
  if (isAbsolute(value) || value.startsWith('~')) {
    return { reason: `Workspace label "${value}" looks like a path; choose a name instead.` };
  }
  const duplicate = siblings.find((row) => row.id !== workspaceId && row.label.trim() === value);
  if (duplicate) {
    return {
      reason: `Workspace label "${value}" is already used by ${duplicate.path} in this space.`,
    };
  }
  return { value };
}
