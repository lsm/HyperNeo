import { createDesktopCallOperation } from '../../desktop/call-operation.ts';
import { createDesktopControlOperation } from '../../desktop/control-operation.ts';
import { createDesktopStatusOperation } from '../../desktop/status-operation.ts';
import { createDesktopStopOperation } from '../../desktop/stop-operation.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import { registerClientOperations } from './clients.ts';
import { registerDriverOperations } from './drivers.ts';
import { registerSessionEventOperations } from './external-events.ts';
import type { FamilyOperationContext } from './context.ts';
import { registerSessionGoalOperations } from './goals.ts';
import { registerSessionOperations } from './session.ts';
import { registerSettingsOperations } from './settings.ts';
import { createProjectFolderOperation } from '../../session/project-folder-operation.ts';

export type { FamilyOperationContext } from './context.ts';

export function collectFamilyOperations(context: FamilyOperationContext): OperationDefinition[] {
  return [
    createDesktopCallOperation(context.deps.db.getDatabase(), {
      getSession: (id) => context.deps.db.getSession(id),
    }),
    createDesktopControlOperation(context.deps.db.getDatabase()),
    createDesktopStatusOperation(context.deps.db.getDatabase()),
    createDesktopStopOperation(),
    createProjectFolderOperation(context.deps.db.workspaceHistory),
    ...registerClientOperations(context),
    ...registerDriverOperations(context),
    ...registerSessionEventOperations(context),
    ...registerSessionGoalOperations(context),
    ...registerSessionOperations(context),
    ...registerSettingsOperations(context),
  ];
}
