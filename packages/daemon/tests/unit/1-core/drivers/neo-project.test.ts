import { describe, expect, test } from 'bun:test';
import {
  ensureNeoProject,
  fileNeoSessions,
  planNeoSessionFiling,
} from '../../../../src/lib/neo/folder';

describe('ensureNeoProject', () => {
  test('registers the Neo folder once, without bumping it on later starts', () => {
    const rows = new Map<string, number>();
    const history = {
      get: (path: string) => (rows.has(path) ? ({ path } as never) : null),
      upsert: (path: string) => {
        rows.set(path, (rows.get(path) ?? 0) + 1);
        return { path } as never;
      },
    };
    expect(ensureNeoProject(history, () => '/data/Neo')).toBe('/data/Neo');
    ensureNeoProject(history, () => '/data/Neo');
    expect([...rows]).toEqual([['/data/Neo', 1]]);
  });
});

describe('planNeoSessionFiling', () => {
  test.each<[string, Parameters<typeof planNeoSessionFiling>[0], string[]]>([
    ['a Neo session with no project', [{ id: 'neo:a', workspacePath: null }], ['neo:a']],
    ['one already under a project', [{ id: 'neo:a', workspacePath: '/data/Neo' }], []],
    ['a binding whose session is gone', [null], []],
  ])('%s', (_label, sessions, filed) => {
    expect(planNeoSessionFiling(sessions)).toEqual(filed);
  });
});

describe('fileNeoSessions', () => {
  test('files the root Neo session when it has no project', async () => {
    const sessions = new Map<string, { id: string; workspacePath: string | null }>([
      ['neo:root', { id: 'neo:root', workspacePath: null }],
      ['neo:inbox', { id: 'neo:inbox', workspacePath: null }],
      ['neo:plans', { id: 'neo:plans', workspacePath: '/elsewhere' }],
    ]);
    const updates: Array<[string, unknown]> = [];
    await fileNeoSessions(
      {
        getSession: (id) => sessions.get(id) ?? null,
        updateSession: async (id, update) => {
          updates.push([id, update]);
        },
      },
      {
        defaultBinding: () => ({ sessionId: 'neo:root', kind: 'neo', projectId: null }),
      },
      '/data/Neo'
    );
    expect(updates).toEqual([['neo:root', { workspacePath: '/data/Neo' }]]);
  });
});
