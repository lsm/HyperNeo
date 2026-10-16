import type { TableChangeScope } from '../../../storage/reactive-database.ts';

export const SPACE_WORKSPACES_BY_SPACE_SQL = `
SELECT
  id,
  space_id as spaceId,
  path,
  label,
  is_primary as isPrimary,
  created_at as createdAt,
  updated_at as updatedAt
FROM space_workspaces
WHERE space_id = ?
ORDER BY is_primary DESC, created_at ASC, id ASC
`;

export function mapSpaceWorkspaceRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    spaceId: row.spaceId,
    path: row.path,
    label: row.label,
    isPrimary: row.isPrimary === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function buildSpaceWorkspacesScopeFilter(
  params: ReadonlyArray<unknown>
): (scope: TableChangeScope) => boolean {
  const spaceId = params[0] as string;
  return (scope) => {
    if (!scope.spaceId) return true;
    return scope.spaceId === spaceId;
  };
}
