import { describe, expect, test } from 'bun:test';
import type { SpaceLongHorizonAgent } from '@hyperneo/shared';
import {
  decideDefaultAgentUpdateAdmission,
  resolveIsDefaultAgent,
} from '../../../../src/lib/space/agents/default-agent-policy';

function coordinatorRepo(row: SpaceLongHorizonAgent | null) {
  return { getCoordinator: () => row };
}

describe('resolveIsDefaultAgent', () => {
  const coordinator = { id: 'space-lh-agent:coordinator:space-1' } as SpaceLongHorizonAgent;

  test('derives default-ness from the coordinator row identity', () => {
    expect(resolveIsDefaultAgent('space-1', coordinator.id, coordinatorRepo(coordinator))).toBe(
      true
    );
    expect(resolveIsDefaultAgent('space-1', 'other-agent', coordinatorRepo(coordinator))).toBe(
      false
    );
  });

  test('a stable derived id alone is not default-ness without the coordinator row', () => {
    expect(resolveIsDefaultAgent('space-1', coordinator.id, coordinatorRepo(null))).toBe(false);
  });

  test('missing agent id or lookup is never default', () => {
    expect(resolveIsDefaultAgent('space-1', undefined, coordinatorRepo(coordinator))).toBe(false);
    expect(resolveIsDefaultAgent('space-1', null, coordinatorRepo(coordinator))).toBe(false);
    expect(resolveIsDefaultAgent('space-1', coordinator.id, undefined)).toBe(false);
  });
});

describe('decideDefaultAgentUpdateAdmission', () => {
  test('non-default agents update freely', () => {
    expect(
      decideDefaultAgentUpdateAdmission({
        isDefaultAgent: false,
        handleChanged: true,
        nextStatus: 'archived',
      })
    ).toEqual({ action: 'allow' });
  });

  test('the default agent rejects handle changes and deactivating statuses', () => {
    expect(
      decideDefaultAgentUpdateAdmission({ isDefaultAgent: true, handleChanged: true })
    ).toMatchObject({ action: 'reject' });
    for (const status of ['paused', 'archived', 'disabled']) {
      expect(
        decideDefaultAgentUpdateAdmission({
          isDefaultAgent: true,
          handleChanged: false,
          nextStatus: status,
        })
      ).toMatchObject({ action: 'reject' });
    }
  });

  test('the default agent keeps editable fields and same-handle updates', () => {
    expect(
      decideDefaultAgentUpdateAdmission({ isDefaultAgent: true, handleChanged: false })
    ).toEqual({ action: 'allow' });
    expect(
      decideDefaultAgentUpdateAdmission({
        isDefaultAgent: true,
        handleChanged: false,
        nextStatus: 'active',
      })
    ).toEqual({ action: 'allow' });
  });
});
