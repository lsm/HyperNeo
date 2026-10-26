import type { Database } from '../../storage/database.ts';
import {
  toolDefaultTransitions,
  type ToolDefaultTransition,
} from '../../storage/repositories/tool-default-transition.ts';

export async function writeToolDefaults(
  db: Pick<Database, 'gateway'>,
  request: ToolDefaultTransition
) {
  const result = await db.gateway.call(toolDefaultTransitions, 'apply', request);
  if (!result.ok)
    throw new Error(
      result.reason === 'default_target_not_found' && request.spaceId
        ? `Space not found: ${request.spaceId}`
        : result.reason
    );
  return result;
}
export async function writeSpaceMcpDefault(
  db: Pick<Database, 'gateway'>,
  spaceId: string,
  serverId: string,
  enabled: boolean | null
) {
  const result = await writeToolDefaults(db, {
    spaceId,
    mutations:
      enabled === null
        ? [{ repository: 'overrides', method: 'clearOverride', args: ['space', spaceId, serverId] }]
        : [
            {
              repository: 'overrides',
              method: 'setOverride',
              args: ['space', spaceId, serverId, enabled],
            },
          ],
    edits: [{ key: `mcp:${serverId}`, selected: enabled }],
  });
  return { changed: result.changed, deleted: enabled === null && result.results[0] === true };
}
