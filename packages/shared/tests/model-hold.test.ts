import { describe, expect, test } from 'bun:test';
import {
  modelHoldLine,
  modelHoldOf,
  shownModelHold,
  type ModelHold,
} from '../src/types/model-hold';

const time = (ms: number) => `t${ms}`;

describe('modelHoldLine', () => {
  test('a login hold asks the human to sign in again', () => {
    expect(modelHoldLine({ provider: 'anthropic', reason: 'login', since: 1 }, time)).toEqual({
      text: 'Claude needs you to sign in again',
      signIn: true,
    });
  });

  test('a usage limit names its reset time', () => {
    expect(
      modelHoldLine({ provider: 'anthropic', reason: 'limit', since: 1, resetAt: 42 }, time)
    ).toEqual({ text: 'Claude usage limit · resets t42', signIn: false });
  });

  test('a usage limit without a reset time says only the limit', () => {
    expect(modelHoldLine({ provider: 'anthropic', reason: 'limit', since: 1 }, time)).toEqual({
      text: 'Claude usage limit',
      signIn: false,
    });
  });

  test('network and overload say the session is retrying', () => {
    expect(modelHoldLine({ provider: 'anthropic', reason: 'network', since: 1 }, time).text).toBe(
      "Can't reach Claude · retrying"
    );
    expect(
      modelHoldLine({ provider: 'anthropic', reason: 'overloaded', since: 1 }, time).text
    ).toBe('Claude is overloaded · retrying');
  });

  test('another provider is named by its id', () => {
    expect(modelHoldLine({ provider: 'glm', reason: 'network', since: 1 }, time).text).toBe(
      "Can't reach glm · retrying"
    );
  });
});

describe('modelHoldOf', () => {
  test('a held state becomes a model hold with its reset time only for a limit', () => {
    const held = { status: 'rate_limit_cooldown', reason: 'limit', since: 5, retryAt: 9 } as const;
    expect(modelHoldOf(held, 'anthropic')).toEqual({
      provider: 'anthropic',
      reason: 'limit',
      since: 5,
      resetAt: 9,
    });
    expect(modelHoldOf({ ...held, reason: 'login' }, 'anthropic')).toEqual({
      provider: 'anthropic',
      reason: 'login',
      since: 5,
    });
  });

  test('a hold without a reason is a usage limit', () => {
    expect(
      modelHoldOf({ status: 'rate_limit_cooldown', since: 5, retryAt: 9 }, 'anthropic')?.reason
    ).toBe('limit');
  });

  test('a session that is not held has no model hold', () => {
    expect(modelHoldOf({ status: 'processing' }, 'anthropic')).toBeUndefined();
    expect(modelHoldOf(null, 'anthropic')).toBeUndefined();
  });
});

describe('shownModelHold', () => {
  const hold = (reason: ModelHold['reason']): ModelHold => ({
    provider: 'anthropic',
    reason,
    since: 1,
  });

  test('a login hold comes first, then the Neo session, and workers are ignored', () => {
    expect(
      shownModelHold([
        { role: 'neo', modelHold: hold('network') },
        { role: 'front', modelHold: hold('login') },
      ])?.reason
    ).toBe('login');
    expect(
      shownModelHold([
        { role: 'front', modelHold: hold('overloaded') },
        { role: 'neo', modelHold: hold('network') },
      ])?.reason
    ).toBe('network');
    expect(shownModelHold([{ modelHold: hold('login') }])).toBeUndefined();
    expect(shownModelHold([{ role: 'neo' }])).toBeUndefined();
  });
});
