import { describe, expect, test } from 'bun:test';
import {
  admitCurrentEpochWaiter,
  admitTransitionOwnedWaiter,
  admitUnownedWaiter,
  isIdleWaiterAdmitted,
  type IdleWaiterAdmissionCtx,
} from '../../../../src/lib/agent/idle-waiter-admission-pipeline';

const OWNER = { queryGeneration: 2, turnToken: 4 };
const NEXT_TURN = { queryGeneration: 2, turnToken: 5 };
const NEXT_QUERY = { queryGeneration: 3, turnToken: 4 };

function ctx(overrides: Partial<IdleWaiterAdmissionCtx> = {}): IdleWaiterAdmissionCtx {
  return {
    waiterOwner: OWNER,
    transitionOwner: undefined,
    currentOwner: OWNER,
    admitted: null,
    ...overrides,
  };
}

describe('isIdleWaiterAdmitted', () => {
  test('an unowned waiter is admitted regardless of the transition owner', () => {
    expect(isIdleWaiterAdmitted({ waiterOwner: undefined, currentOwner: OWNER })).toBe(true);
    expect(
      isIdleWaiterAdmitted({
        waiterOwner: undefined,
        transitionOwner: OWNER,
        currentOwner: NEXT_QUERY,
      })
    ).toBe(true);
    expect(
      isIdleWaiterAdmitted({
        waiterOwner: undefined,
        transitionOwner: NEXT_TURN,
        currentOwner: OWNER,
      })
    ).toBe(true);
  });

  test('an owned waiter is admitted only on an exact owner match', () => {
    expect(
      isIdleWaiterAdmitted({ waiterOwner: OWNER, transitionOwner: OWNER, currentOwner: NEXT_QUERY })
    ).toBe(true);
    expect(
      isIdleWaiterAdmitted({ waiterOwner: OWNER, transitionOwner: NEXT_TURN, currentOwner: OWNER })
    ).toBe(false);
    expect(
      isIdleWaiterAdmitted({ waiterOwner: OWNER, transitionOwner: NEXT_QUERY, currentOwner: OWNER })
    ).toBe(false);
  });

  test('without a transition owner, owned waiters of the current epoch are admitted', () => {
    expect(isIdleWaiterAdmitted({ waiterOwner: OWNER, currentOwner: OWNER })).toBe(true);
    expect(
      isIdleWaiterAdmitted({
        waiterOwner: { queryGeneration: 2, turnToken: 1 },
        currentOwner: OWNER,
      })
    ).toBe(true);
  });

  test('without a transition owner, owned waiters of a newer epoch are held', () => {
    expect(isIdleWaiterAdmitted({ waiterOwner: NEXT_TURN, currentOwner: OWNER })).toBe(false);
    expect(isIdleWaiterAdmitted({ waiterOwner: NEXT_QUERY, currentOwner: OWNER })).toBe(false);
  });
});

describe('admission stages', () => {
  test('admitUnownedWaiter decides unowned waiters and passes owned ones through', () => {
    expect(admitUnownedWaiter(ctx({ waiterOwner: undefined })).admitted).toBe(true);
    expect(admitUnownedWaiter(ctx()).admitted).toBeNull();
  });

  test('admitTransitionOwnedWaiter matches both owner fields exactly', () => {
    expect(admitTransitionOwnedWaiter(ctx()).admitted).toBeNull();
    expect(admitTransitionOwnedWaiter(ctx({ transitionOwner: OWNER })).admitted).toBe(true);
    expect(admitTransitionOwnedWaiter(ctx({ transitionOwner: NEXT_TURN })).admitted).toBe(false);
    expect(admitTransitionOwnedWaiter(ctx({ transitionOwner: NEXT_QUERY })).admitted).toBe(false);
  });

  test('admitCurrentEpochWaiter admits same-generation waiters up to the current turn token', () => {
    expect(admitCurrentEpochWaiter(ctx()).admitted).toBe(true);
    expect(
      admitCurrentEpochWaiter(ctx({ waiterOwner: { queryGeneration: 2, turnToken: 0 } })).admitted
    ).toBe(true);
    expect(admitCurrentEpochWaiter(ctx({ waiterOwner: NEXT_TURN })).admitted).toBe(false);
    expect(admitCurrentEpochWaiter(ctx({ waiterOwner: NEXT_QUERY })).admitted).toBe(false);
  });
});
