import { describe, expect, test } from 'bun:test';
import { OPERATION_NAMES } from '@hyperneo/shared/types/operation-names';
import { collectFamilyOperations } from '../../../../src/lib/rpc-handlers/family-operations/index.ts';
import { collectSpaceFamilyOperations } from '../../../../../space/src/rpc/family-operations/space.ts';
import type { SpaceFamilyContext } from '../../../../../space/src/rpc/family-operations/space-context.ts';

function fakeContext(): SpaceFamilyContext {
  return {
    deps: {
      db: {
        getSession: () => null,
        getDatabase: () => ({}),
        gateway: { call: async () => null },
      },
      config: { dbPath: '/synthetic/family-operations.db' },
      jobProcessor: { register: () => {} },
    },
    externalEventStore: {},
    spaceGoalService: {},
    longHorizonAgentRepo: {},
    nodeExecutionRepo: {},
    spaceTaskRepo: {},
    sessionScheduler: { registerSource: () => {} },
    neoPacks: () => [],
  } as unknown as SpaceFamilyContext;
}

const allFamilyOperations = () => [
  ...collectFamilyOperations({
    ...fakeContext(),
    sessionSpace: {} as SpaceFamilyContext['sessionSpace'],
  }),
  ...collectSpaceFamilyOperations(fakeContext()),
];

describe('family operation registration', () => {
  test('returns every ported family operation exactly once', () => {
    const names = allFamilyOperations().map((operation) => operation.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        'goal.get',
        'goal.list',
        'event.external.get',
        'event.external.delivery.list',
        'event.external.agent.subscription.list',
        'event.external.subscribe',
        'event.external.unsubscribe',
        'agent.template.create',
        'agent.template.update',
        'agent.template.delete',
        'agent.template.list',
        'agent.template.instantiate',
        'space.list',
        'space.get',
        'work.health',
      ])
    );
  });

  test('registers only names declared in OPERATION_NAMES', () => {
    const declared = new Set<string>(OPERATION_NAMES);
    const undeclared = allFamilyOperations()
      .map((operation) => operation.name)
      .filter((name) => !declared.has(name));
    expect(undeclared).toEqual([]);
  });
});
