import { ClientRegistrationRepository } from '../../../storage/repositories/client-registration-repository.ts';
import { createClientOperations } from '../../clients/client-operations.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import type { FamilyOperationContext } from './context.ts';

export function registerClientOperations(context: FamilyOperationContext): OperationDefinition[] {
  return createClientOperations(new ClientRegistrationRepository(context.deps.db.getDatabase()));
}
