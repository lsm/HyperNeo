import type { OperationDefinition } from '../../../../daemon/src/lib/operations/registry.ts';
import { createSpaceReadOperations } from '../../../../daemon/src/lib/space/space-read-operations.ts';
import type { SpaceFamilyContext } from './space-context.ts';

export function registerSpaceOperations(context: SpaceFamilyContext): OperationDefinition[] {
  return createSpaceReadOperations({
    listSpaces: (includeArchived) => context.spaceManager.listSpaces(includeArchived),
    getSpace: (spaceId) => context.spaceManager.getSpace(spaceId),
  });
}
