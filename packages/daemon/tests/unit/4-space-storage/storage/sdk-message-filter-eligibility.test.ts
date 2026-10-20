import { describe, expect, test } from 'bun:test';
import { deriveSdkMessageColumns } from '../../../../src/storage/sdk-message-columns';

describe('SDK message filter eligibility contracts', () => {
  test.each([
    ['missing', {}, 1],
    ['false', { isReplay: false }, 1],
    ['null', { isReplay: null }, 0],
    ['zero', { isReplay: 0 }, 0],
    ['true', { isReplay: true }, 0],
    ['one', { isReplay: 1 }, 0],
    ['text false', { isReplay: 'false' }, 0],
    ['text zero', { isReplay: '0' }, 0],
    ['mismatched type', { type: 'assistant' }, 0],
  ] as const)('status projection preserves the %s replay case', (_name, body, eligible) => {
    expect(deriveSdkMessageColumns({ type: 'user', ...body })).toMatchObject({
      user_status_eligible: eligible,
    });
  });

  test.each([
    ['task', { inputKind: 'task' }, 1],
    ['task with false synthetic flag', { inputKind: 'task', isSynthetic: false }, 1],
    ['missing', { isSynthetic: true }, 1],
    ['null', { inputKind: null, isSynthetic: true }, 0],
    ['false', { inputKind: false, isSynthetic: true }, 0],
    ['zero', { inputKind: 0, isSynthetic: true }, 0],
    ['system', { inputKind: 'system', isSynthetic: true }, 0],
    ['human', { inputKind: 'human', isSynthetic: true }, 0],
    ['missing with false synthetic flag', { isSynthetic: false }, 0],
    ['missing with zero synthetic flag', { isSynthetic: 0 }, 0],
    ['missing with null synthetic flag', { isSynthetic: null }, 0],
    ['missing with integer synthetic flag', { isSynthetic: 1 }, 1],
    ['missing with fractional synthetic flag', { isSynthetic: 1.75 }, 1],
    ['missing with numeric text synthetic flag', { isSynthetic: '1tail' }, 1],
    ['missing with exponent text synthetic flag', { isSynthetic: '1e2' }, 1],
    ['missing with non-SQL whitespace', { isSynthetic: '\u00a01' }, 0],
    ['mismatched type', { type: 'assistant', inputKind: 'task' }, 0],
  ] as const)('task projection preserves the %s input case', (_name, body, eligible) => {
    expect(deriveSdkMessageColumns({ type: 'user', ...body })).toMatchObject({
      task_input_eligible: eligible,
    });
  });
});
