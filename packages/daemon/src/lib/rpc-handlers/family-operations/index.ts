import type { OperationDefinition } from '../../operations/registry.ts';
import { registerAgentOperations } from './agents.ts';
import type { FamilyOperationContext } from './context.ts';
import { registerEvolutionOperations } from './evolution.ts';
import { registerExternalEventOperations } from './external-events.ts';
import { registerGoalOperations } from './goals.ts';
import { registerMessagingOperations } from './messaging.ts';
import { registerScheduleOperations } from './schedule.ts';
import { registerSessionOperations } from './session.ts';
import { registerWorkflowOperations } from './workflows.ts';

export type { FamilyOperationContext } from './context.ts';

export function collectFamilyOperations(context: FamilyOperationContext): OperationDefinition[] {
  return [
    ...registerAgentOperations(context),
    ...registerEvolutionOperations(context),
    ...registerExternalEventOperations(context),
    ...registerGoalOperations(context),
    ...registerMessagingOperations(context),
    ...registerScheduleOperations(context),
    ...registerSessionOperations(context),
    ...registerWorkflowOperations(context),
  ];
}
