/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import { isSpaceActionsDispatcherEnabled } from '../../../../src/lib/space/actions/dispatcher-flag.ts';

describe('isSpaceActionsDispatcherEnabled', () => {
  const FLAG = 'HYPERNEO_SPACE_ACTIONS_DISPATCHER';
  const previous = process.env[FLAG];
  afterEach(() => {
    if (previous === undefined) delete process.env[FLAG];
    else process.env[FLAG] = previous;
  });

  test('defaults to on when the flag is unset', () => {
    delete process.env[FLAG];
    expect(isSpaceActionsDispatcherEnabled()).toBe(true);
  });

  test('enables only for explicit 1/true values', () => {
    for (const value of ['1', 'true']) {
      process.env[FLAG] = value;
      expect(isSpaceActionsDispatcherEnabled()).toBe(true);
    }
  });

  test('disables for explicit 0/false values or other non-truthy strings', () => {
    for (const value of ['0', 'false', 'yes', '']) {
      process.env[FLAG] = value;
      expect(isSpaceActionsDispatcherEnabled()).toBe(false);
    }
  });
});
