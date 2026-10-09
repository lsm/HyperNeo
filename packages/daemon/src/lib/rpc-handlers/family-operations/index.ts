import type { OperationDefinition } from '../../operations/registry.ts';
import { registerAgentOperations } from './agents.ts';
import { registerArtifactOperations } from './artifacts.ts';
import { registerAuditOperations } from './audit.ts';
import { registerClientOperations } from './clients.ts';
import { registerDriverOperations } from './drivers.ts';
import type { FamilyOperationContext } from './context.ts';
import { registerEvolutionOperations } from './evolution.ts';
import { registerExternalEventOperations } from './external-events.ts';
import { registerGoalOperations } from './goals.ts';
import { registerMessagingOperations } from './messaging.ts';
import { registerScheduleOperations } from './schedule.ts';
import { registerSessionOperations } from './session.ts';
import { registerSettingsOperations } from './settings.ts';
import { registerSpaceOperations } from './spaces.ts';
import { registerWorkflowOperations } from './workflows.ts';

export type { FamilyOperationContext } from './context.ts';

export function collectFamilyOperations(context: FamilyOperationContext): OperationDefinition[] {
  return [
    ...registerAgentOperations(context),
    ...registerArtifactOperations(context),
    ...registerAuditOperations(context),
    ...registerClientOperations(context),
    ...registerDriverOperations(context),
    ...registerEvolutionOperations(context),
    ...registerExternalEventOperations(context),
    ...registerGoalOperations(context),
    ...registerMessagingOperations(context),
    ...registerScheduleOperations(context),
    ...registerSessionOperations(context),
    ...registerSettingsOperations(context),
    ...registerSpaceOperations(context),
    ...registerWorkflowOperations(context),
  ];
}
