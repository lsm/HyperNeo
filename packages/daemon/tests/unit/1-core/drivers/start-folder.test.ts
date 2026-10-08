import { describe, expect, test } from 'bun:test';
import { ensureStartFolder } from '../../../../src/lib/drivers/start-folder';

function deps(existing: string[], fail?: string) {
  const made: string[] = [];
  return {
    made,
    deps: {
      homeDir: '/Users/me',
      folderExists: (folder: string) => existing.includes(folder) || made.includes(folder),
      makeFolder: (folder: string) => {
        if (fail) throw new Error(fail);
        made.push(folder);
      },
    },
  };
}

describe('ensureStartFolder', () => {
  test('uses an existing folder without creating anything', () => {
    const { made, deps: d } = deps(['/opt/work']);
    expect(ensureStartFolder('/opt/work', true, d)).toEqual({ value: '/opt/work' });
    expect(made).toEqual([]);
  });

  test('refuses a missing folder unless createFolder is set', () => {
    const { made, deps: d } = deps(['/Users/me/focus']);
    expect(ensureStartFolder('/Users/me/focus/neo-ios', undefined, d)).toEqual({
      reason: {
        ok: false,
        reason: 'invalid_place',
        detail:
          '/Users/me/focus/neo-ios does not exist. To start a new project there, pass createFolder: true.',
      },
    });
    expect(made).toEqual([]);
  });

  test('creates a new project folder under an existing parent in the home folder', () => {
    const { made, deps: d } = deps(['/Users/me/focus']);
    expect(ensureStartFolder('/Users/me/focus/neo-ios', true, d)).toEqual({
      value: '/Users/me/focus/neo-ios',
    });
    expect(made).toEqual(['/Users/me/focus/neo-ios']);
  });

  test.each([
    ['/tmp/neo-ios', 'New folders can only be created inside /Users/me.'],
    ['/Users/other/neo', 'New folders can only be created inside /Users/me.'],
    [
      '/Users/me/focus/../../other/x',
      '/Users/me/focus/../../other/x is not a plain absolute path.',
    ],
    ['focus/neo-ios', 'focus/neo-ios is not a plain absolute path.'],
    ['/Users/me/.ssh/neo', 'New folders cannot be created inside .ssh.'],
    ['/Users/me/Library/neo', 'New folders cannot be created inside Library.'],
    [
      '/Users/me/focus/typo/deep/neo',
      '/Users/me/focus/typo/deep does not exist, so /Users/me/focus/typo/deep/neo was not created.',
    ],
  ])('refuses to create %s', (folder, detail) => {
    const { made, deps: d } = deps(['/Users/me', '/Users/me/focus', '/Users/me/.ssh']);
    expect(ensureStartFolder(folder, true, d)).toEqual({
      reason: { ok: false, reason: 'invalid_place', detail },
    });
    expect(made).toEqual([]);
  });

  test('reports a folder the system could not create', () => {
    const { deps: d } = deps(['/Users/me/focus'], 'EACCES: permission denied');
    expect(ensureStartFolder('/Users/me/focus/neo-ios', true, d)).toEqual({
      reason: {
        ok: false,
        reason: 'invalid_place',
        detail: 'Could not create /Users/me/focus/neo-ios: EACCES: permission denied',
      },
    });
  });
});
