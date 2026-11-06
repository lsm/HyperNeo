import type { OperationDefinition } from '../../../operations/registry.ts';
import { createSpaceReadOperations } from '../../space-read-operations.ts';
import type { SpaceFamilyContext } from './space-context.ts';

export function registerSpaceOperations(context: SpaceFamilyContext): OperationDefinition[] {
  return createSpaceReadOperations({
    listSpaces: (includeArchived) => context.spaceManager.listSpaces(includeArchived),
    getSpace: (spaceId) => context.spaceManager.getSpace(spaceId),
  });
}
