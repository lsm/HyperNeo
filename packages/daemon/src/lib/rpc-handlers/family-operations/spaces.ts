import type { OperationDefinition } from '../../operations/registry.ts';
import { createSpaceReadOperations } from '../../space/space-read-operations.ts';
import type { FamilyOperationContext } from './context.ts';

export function registerSpaceOperations(context: FamilyOperationContext): OperationDefinition[] {
  return createSpaceReadOperations({
    listSpaces: (includeArchived) => context.deps.spaceManager.listSpaces(includeArchived),
    getSpace: (spaceId) => context.deps.spaceManager.getSpace(spaceId),
  });
}
