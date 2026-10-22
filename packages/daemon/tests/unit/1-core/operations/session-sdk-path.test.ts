import { describe, expect, test } from 'bun:test';
import { sessionSdkPath } from '../../../../src/lib/session/sdk-path.ts';

describe('sessionSdkPath', () => {
  test.each([
    [{ workspacePath: '/repo' }, '/repo'],
    [{ workspacePath: '/repo', worktree: { worktreePath: '/worktree' } }, '/worktree'],
    [{ workspacePath: null }, null],
  ])('keeps the same persisted SDK origin for every session', (session, expected) => {
    expect(sessionSdkPath(session as Parameters<typeof sessionSdkPath>[0])).toBe(expected);
  });
});
