import type { OperationDefinition } from '../../operations/registry.ts';
import { createSpaceReadOperations } from '../../space/space-read-operations.ts';
import type { SpaceFamilyContext } from './space-context.ts';

export function registerSpaceOperations(context: SpaceFamilyContext): OperationDefinition[] {
  return createSpaceReadOperations({
    listSpaces: (includeArchived) => context.deps.spaceManager.listSpaces(includeArchived),
    getSpace: (spaceId) => context.deps.spaceManager.getSpace(spaceId),
  });
}
