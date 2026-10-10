import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  neoCoordinatorRuntimePath,
  sessionSdkPath,
} from '../../../../src/lib/neo/session-policy.ts';
import type { Database } from '../../../../src/storage/database.ts';

describe('neoCoordinatorRuntimePath', () => {
  let home: string;
  const saved = { sdk: process.env.TEST_SDK_SESSION_DIR, data: process.env.HYPERNEO_DATA_DIR };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'neo-home-'));
    process.env.TEST_SDK_SESSION_DIR = join(home, '.claude');
    process.env.HYPERNEO_DATA_DIR = join(home, 'data');
  });
  afterEach(() => {
    if (saved.sdk === undefined) delete process.env.TEST_SDK_SESSION_DIR;
    else process.env.TEST_SDK_SESSION_DIR = saved.sdk;
    if (saved.data === undefined) delete process.env.HYPERNEO_DATA_DIR;
    else process.env.HYPERNEO_DATA_DIR = saved.data;
    rmSync(home, { recursive: true, force: true });
  });

  test('runs each new coordinator in its own folder inside the Neo project', () => {
    expect(neoCoordinatorRuntimePath('neo:new-session')).toBe(
      join(home, 'data', 'Neo', '.coordinators', 'neo-new-session')
    );
    expect(neoCoordinatorRuntimePath('neo:other')).not.toBe(
      neoCoordinatorRuntimePath('neo:new-session')
    );
  });

  test('keeps a coordinator whose SDK history lives under its old folder', () => {
    const legacy = join(tmpdir(), 'hyperneo-neo-context', 'neo-old-session');
    mkdirSync(legacy, { recursive: true });
    const encoded = realpathSync(legacy).replace(/[/.]/g, '-');
    mkdirSync(join(home, '.claude', 'projects', encoded), { recursive: true });
    expect(neoCoordinatorRuntimePath('neo:old-session')).toBe(legacy);
  });

  test('still finds that history after the OS removed the old temp folder', () => {
    const legacy = join(tmpdir(), 'hyperneo-neo-context', 'neo-gone-session');
    const encoded = `/private${legacy}`.replace(/[/.]/g, '-');
    mkdirSync(join(home, '.claude', 'projects', encoded), { recursive: true });
    expect(neoCoordinatorRuntimePath('neo:gone-session')).toBe(legacy);
  });
});

describe('sessionSdkPath', () => {
  test.each<
    [
      string,
      string,
      { workspacePath: string | null; worktree?: { worktreePath: string } },
      string | null,
    ]
  >([
    [
      'a Neo session filed under the Neo project',
      'neo:root',
      { workspacePath: '/data/Neo' },
      'coordinator',
    ],
    [
      'a worktree session',
      'plain',
      { workspacePath: '/repo', worktree: { worktreePath: '/repo-wt' } },
      '/repo-wt',
    ],
    ['a project session', 'plain', { workspacePath: '/repo' }, '/repo'],
    ['an unbound session', 'plain', { workspacePath: null }, null],
  ])('keeps SDK history of %s where its query runs', (_label, id, session, path) => {
    const db = {
      getDatabase: () => ({
        prepare: () => ({
          get: (sessionId: string) =>
            sessionId === 'neo:root' ? { sessionId, concernId: null, kind: 'neo' } : null,
        }),
      }),
    } as unknown as Database;
    expect(sessionSdkPath(db, { id, ...session } as Parameters<typeof sessionSdkPath>[1])).toBe(
      path === 'coordinator' ? neoCoordinatorRuntimePath(id) : path
    );
  });
});
