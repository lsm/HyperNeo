import type { OperationDefinition } from '../../operations/registry.ts';
import { registerClientOperations } from './clients.ts';
import { registerDriverOperations } from './drivers.ts';
import type { FamilyOperationContext } from './context.ts';
import { registerSessionGoalOperations } from './goals.ts';
import { registerSessionOperations } from './session.ts';
import { registerSettingsOperations } from './settings.ts';
import { createProjectFolderOperation } from '../../session/project-folder-operation.ts';

export type { FamilyOperationContext } from './context.ts';

export function collectFamilyOperations(context: FamilyOperationContext): OperationDefinition[] {
  return [
    createProjectFolderOperation(context.deps.db.workspaceHistory),
    ...registerClientOperations(context),
    ...registerDriverOperations(context),
    ...registerSessionGoalOperations(context),
    ...registerSessionOperations(context),
    ...registerSettingsOperations(context),
  ];
}
