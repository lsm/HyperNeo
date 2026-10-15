import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addNamedPlace,
  createFindWorkOperation,
  expandFindFolder,
  readNamedFolder,
  type FindWorkDeps,
} from '../../../../src/lib/drivers/find-operation';
import type { PlaceGroup, WorkAdapter } from '../../../../src/lib/drivers/types';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';

const base = { includeClosed: false, limit: 20, localOnly: false };

function deps(directories: string[] = [], adapters: WorkAdapter[] = []): FindWorkDeps {
  return {
    adapters: () => adapters,
    remote: { list: () => [], invoke: async () => ({}) },
    namedFolder: {
      machine: 'laptop',
      homeDir: '/Users/me',
      isDirectory: (folder) => directories.includes(folder),
    },
  };
}

function known(folder: string, workspaces?: string[]): PlaceGroup {
  return {
    place: { machine: 'laptop', folder, name: 'known' },
    ...(workspaces
      ? { workspaces: workspaces.map((path) => ({ machine: 'laptop', folder: path, name: 'w' })) }
      : {}),
    lastActivityAt: 5,
    openCount: 1,
    archivedCount: 0,
    adapters: ['codex-desktop'],
    work: [],
  };
}

describe('expandFindFolder', () => {
  test('expands a home-relative folder and drops a trailing slash', () => {
    expect(expandFindFolder({ ...base, folder: '~/focus/review-test/' }, deps()).folder).toBe(
      '/Users/me/focus/review-test'
    );
    expect(expandFindFolder({ ...base, folder: '~' }, deps()).folder).toBe('/Users/me');
  });

  test('normalizes an absolute folder and leaves a relative one alone', () => {
    expect(expandFindFolder({ ...base, folder: '/Users/me/focus/../repo' }, deps()).folder).toBe(
      '/Users/me/repo'
    );
    expect(expandFindFolder({ ...base, folder: 'focus/repo' }, deps()).folder).toBe('focus/repo');
  });

  test('changes nothing without a folder or without named-folder deps', () => {
    const input = { ...base, text: 'repo' };
    expect(expandFindFolder(input, deps())).toBe(input);
    const named = { ...base, folder: '~/repo' };
    expect(expandFindFolder(named, { ...deps(), namedFolder: undefined })).toBe(named);
  });
});

describe('readNamedFolder', () => {
  test('names an existing absolute directory', () => {
    expect(
      readNamedFolder({ ...base, folder: '/Users/me/repo' }, deps(['/Users/me/repo']))
    ).toEqual({ folder: '/Users/me/repo' });
  });

  test('names nothing for a missing, relative or id lookup folder', () => {
    expect(readNamedFolder({ ...base, folder: '/Users/me/gone' }, deps())).toEqual({});
    expect(readNamedFolder({ ...base, folder: 'repo' }, deps(['repo']))).toEqual({});
    expect(
      readNamedFolder({ ...base, folder: '/Users/me/repo', id: 'x' }, deps(['/Users/me/repo']))
    ).toEqual({});
  });
});

describe('addNamedPlace', () => {
  const empty = { groups: [], unreachable: [] };

  test('adds a named folder no adapter knows as an empty place on this machine', () => {
    expect(addNamedPlace(empty, { folder: '/Users/me/review-test' }, deps()).groups).toEqual([
      {
        place: { machine: 'laptop', folder: '/Users/me/review-test', name: 'review-test' },
        lastActivityAt: 0,
        openCount: 0,
        archivedCount: 0,
        adapters: [],
        work: [],
      },
    ]);
  });

  test('keeps the found place when an adapter already returned the folder', () => {
    const outcome = { groups: [known('/Users/me/repo')], unreachable: [] };
    expect(addNamedPlace(outcome, { folder: '/Users/me/repo' }, deps())).toBe(outcome);
    const merged = { groups: [known('/Users/me/main', ['/Users/me/repo'])], unreachable: [] };
    expect(addNamedPlace(merged, { folder: '/Users/me/repo' }, deps())).toBe(merged);
  });

  test('adds nothing when no folder was named', () => {
    expect(addNamedPlace(empty, {}, deps())).toBe(empty);
  });
});

describe('work.find with a named folder', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'named-folder-'));
    mkdirSync(join(home, 'review-test'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('returns a folder the human named as a place even though no work ran there', async () => {
    const elsewhere: WorkAdapter = {
      id: 'codex-desktop',
      capabilities: ['find'],
      find: (query) => (query.folder ? [] : [known('/Users/me/other')]),
    };
    const remoteInputs: unknown[] = [];
    const ops = createOperationRegistry([
      createFindWorkOperation({
        adapters: () => [elsewhere],
        remote: {
          list: () => [{ daemonId: 'imac' }],
          invoke: async (_daemon, _name, input) => {
            remoteInputs.push(input);
            return { places: [], unreachable: [] };
          },
        },
        namedFolder: {
          machine: 'laptop',
          homeDir: home,
          isDirectory: (folder) =>
            statSync(folder, { throwIfNoEntry: false })?.isDirectory() === true,
        },
      }),
    ]);
    const outcome = await invokeOperation(
      ops,
      'work.find',
      { folder: '~/review-test' },
      { source: 'mcp', sessionId: 'neo:root' }
    );
    const places =
      outcome.kind === 'completed' ? (outcome.value as { places: PlaceGroup[] }).places : [];
    expect(places.map((group) => [group.place.folder, group.place.name, group.work])).toEqual([
      [join(home, 'review-test'), 'review-test', []],
    ]);
    expect(remoteInputs).toEqual([expect.objectContaining({ folder: '~/review-test' })]);
  });
});
