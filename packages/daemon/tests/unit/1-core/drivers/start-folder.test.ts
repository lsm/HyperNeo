import { describe, expect, test } from 'bun:test';
import {
  createStartFolder,
  ensureStartFolder,
  requireStartFolder,
} from '../../../../src/lib/drivers/start-folder';

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

describe('requireStartFolder', () => {
  const home = { homeDir: '/Users/me' };
  test('decides from what was read, without touching the disk', () => {
    expect(
      requireStartFolder('/Users/me/new', true, { exists: false, parentExists: true }, home)
    ).toEqual({ value: { folder: '/Users/me/new', create: true } });
    expect(
      requireStartFolder('/Users/me/a/new', true, { exists: false, parentExists: false }, home)
    ).toMatchObject({ reason: { reason: 'invalid_place' } });
    expect(
      requireStartFolder('/Users/me/old', false, { exists: true, parentExists: true }, home)
    ).toEqual({ value: { folder: '/Users/me/old', create: false } });
  });
});

describe('createStartFolder', () => {
  test('creates only a folder the gate said to create', () => {
    const made: string[] = [];
    const makeFolder = (folder: string) => {
      made.push(folder);
    };
    expect(createStartFolder({ folder: '/Users/me/old', create: false }, { makeFolder })).toEqual({
      value: '/Users/me/old',
    });
    expect(made).toEqual([]);
    createStartFolder({ folder: '/Users/me/new', create: true }, { makeFolder });
    expect(made).toEqual(['/Users/me/new']);
  });
});
