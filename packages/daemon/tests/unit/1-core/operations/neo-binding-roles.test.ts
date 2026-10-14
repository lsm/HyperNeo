import { describe, expect, test } from 'bun:test';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import {
  isMainNeoBinding,
  isNeoCoordinatorBinding,
} from '../../../../src/lib/neo/binding-roles.ts';

const binding = (kind: NeoBinding['kind'], projectId: string | null): NeoBinding => ({
  sessionId: 's',
  kind,
  projectId,
});

describe('isMainNeoBinding', () => {
  test.each([
    ['main Neo', binding('neo', null), true],
    ['a Neo binding with a concern', binding('neo', 'c'), false],
    ['a concern', binding('project', 'c'), false],
    ['a worker', binding('worker', null), false],
    ['no binding', null, false],
  ] as const)('%s', (_label, value, expected) => {
    expect(isMainNeoBinding(value)).toBe(expected);
  });
});

describe('isNeoCoordinatorBinding', () => {
  test.each([
    ['main Neo', binding('neo', null), true],
    ['a concern', binding('project', 'c'), true],
    ['a concern without its id', binding('project', null), false],
    ['a worker', binding('worker', 'c'), false],
    ['no binding', undefined, false],
  ] as const)('%s', (_label, value, expected) => {
    expect(isNeoCoordinatorBinding(value)).toBe(expected);
  });
});
