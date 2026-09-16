import { describe, expect, test } from 'bun:test';
import { OPERATION_NAMES } from '@hyperneo/shared/types/operation-names';
import {
  collectFamilyOperations,
  type FamilyOperationContext,
} from '../../../../src/lib/rpc-handlers/family-operations/index.ts';

function fakeContext(): FamilyOperationContext {
  return {
    deps: { db: { getSession: () => null }, externalEventStore: {} },
    spaceGoalService: {},
    longHorizonAgentRepo: {},
    nodeExecutionRepo: {},
    spaceTaskRepo: {},
  } as unknown as FamilyOperationContext;
}

describe('collectFamilyOperations', () => {
  test('returns every ported family operation exactly once', () => {
    const names = collectFamilyOperations(fakeContext()).map((operation) => operation.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        'goal.get',
        'goal.list',
        'externalEvent.get',
        'externalEvent.listDeliveries',
      ])
    );
  });

  test('registers only names declared in OPERATION_NAMES', () => {
    const declared = new Set<string>(OPERATION_NAMES);
    const undeclared = collectFamilyOperations(fakeContext())
      .map((operation) => operation.name)
      .filter((name) => !declared.has(name));
    expect(undeclared).toEqual([]);
  });
});
