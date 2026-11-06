import { describe, expect, mock, test } from 'bun:test';
import { removeTempDir } from '../../../../../scripts/remove-temp-dir.ts';

const failure = (code: string) => Object.assign(new Error(code), { code });

function failingTimes(times: number, code = 'EBUSY') {
  let calls = 0;
  return mock(() => {
    calls += 1;
    if (calls <= times) throw failure(code);
  });
}

describe('removeTempDir', () => {
  test('retries a folder Windows still holds after a process exits', () => {
    const remove = failingTimes(2);
    const warn = mock(() => {});
    removeTempDir('run', { remove, wait: () => {}, warn });
    expect(remove).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
  });

  test('warns instead of failing when the folder stays locked', () => {
    const remove = failingTimes(Number.POSITIVE_INFINITY, 'EPERM');
    const warn = mock(() => {});
    removeTempDir('run', { remove, wait: () => {}, warn });
    expect(remove).toHaveBeenCalledTimes(20);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('keeps other failures loud', () => {
    expect(() =>
      removeTempDir('run', { remove: failingTimes(1, 'EINVAL'), wait: () => {}, warn: () => {} })
    ).toThrow('EINVAL');
  });
});
