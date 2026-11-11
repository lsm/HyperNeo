import type { OperationName } from '../packages/shared/src/types/operation-names.ts';
import { NEO_CORE_OPERATION_NAMES } from '../packages/daemon/src/lib/operations/core-signatures.ts';
import { isOperationAdmitted } from '../packages/daemon/src/lib/operations/invoke.ts';
import { NEO_RARE_OPERATION_NAMES } from '../packages/daemon/src/lib/operations/neo-discovery.ts';
import type { OperationDefinition } from '../packages/daemon/src/lib/operations/registry.ts';

const excludedNamespaces = {
  task: 'Workflow and task internals use the work interface.',
  workflow: 'Workflow internals belong to their workers.',
  agent: 'Long-horizon agent administration belongs to its owning subsystem.',
  evolution: 'Evolution internals belong to their owning subsystem.',
  space: 'Space administration belongs to the owning subsystem.',
  session: 'Raw session controls and transcripts use work and scoped conversation reads.',
  settings: 'Global configuration belongs to human settings.',
  device: 'Device administration belongs to authenticated human routes.',
  client: 'Client administration belongs to authenticated human routes.',
  connections: 'Connection administration belongs to authenticated human routes.',
};
const excludedOperations = {
  'daemon.attach': 'Operator attachment settings.',
  'daemon.detach': 'Operator attachment settings.',
  'daemon.extensions': 'Operator extension diagnostics.',
  'daemon.list': 'Operator connection inventory.',
  'daemon.probe': 'Operator connection diagnostics.',
  'file.reference.read': 'Paired-human live file preview.',
  'neo.open': 'Client bootstrap; Neo already has its binding.',
  'neo.question.relayAnswer': 'Verified CLI relay transport.',
  'goal.create': 'Space goal administration; Neo uses session goals and journals.',
  'goal.event.list': 'Space goal administration; Neo uses session goals and journals.',
  'goal.get': 'Space goal administration; Neo uses session goals and journals.',
  'goal.list': 'Space goal administration; Neo uses session goals and journals.',
  'goal.outcome.list': 'Space goal administration; Neo uses session goals and journals.',
  'goal.outcome.resolve': 'Space goal administration; Neo uses session goals and journals.',
  'goal.owner.get': 'Space goal administration; Neo uses session goals and journals.',
  'goal.owner.set': 'Space goal administration; Neo uses session goals and journals.',
  'goal.task.list': 'Space goal administration; Neo uses session goals and journals.',
  'goal.task.trigger': 'Space goal administration; Neo uses session goals and journals.',
  'goal.update': 'Space goal administration; Neo uses session goals and journals.',
  'schedule.create': 'Space-task schedules; Neo uses session schedules.',
  'schedule.delete': 'Space-task schedules; Neo uses session schedules.',
  'schedule.get': 'Space-task schedules; Neo uses session schedules.',
  'schedule.list': 'Space-task schedules; Neo uses session schedules.',
  'schedule.update': 'Space-task schedules; Neo uses session schedules.',
  'system.build': 'Build and process diagnostics belong to the daemon operator.',
} as const satisfies Partial<Record<OperationName, string>>;

export function unclassifiedNeoOperations(operations: readonly OperationDefinition[]): string[] {
  const rare = new Set<string>(NEO_RARE_OPERATION_NAMES);
  const resident = new Set<string>(NEO_CORE_OPERATION_NAMES);
  const enabled = [
    ...new Set(operations.flatMap((operation) => (operation.pack ? [operation.pack.id] : []))),
  ];
  return operations
    .filter((operation) => isOperationAdmitted(operation, { source: 'mcp', role: 'neo' }, enabled))
    .map(({ name }) => name)
    .filter(
      (name) =>
        !rare.has(name) &&
        !resident.has(name) &&
        !Object.hasOwn(excludedOperations, name) &&
        !Object.hasOwn(excludedNamespaces, name.split('.')[0]) &&
        name !== 'operations.list' &&
        name !== 'operations.describe'
    )
    .sort();
}
