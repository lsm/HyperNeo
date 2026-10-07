import { describe, expect, test } from 'bun:test';
import type { CodexAppServer } from '../../../../src/lib/drivers/codex-app-server';
import {
  createCodexDesktopAdapter,
  startedThreadId,
} from '../../../../src/lib/drivers/codex-desktop-adapter';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const user = { from: 'user', caller: { source: 'rpc' as const } };
const place = { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen' };
const request = { place, title: 'Bigger font', message: 'Raise the body font to 16px.' };

function adapter(
  server: Partial<CodexAppServer> | Error,
  folders = ['/focus/dolmen'],
  git: { root?: string; exit?: number } = {}
) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const spawned: Array<{ args: string[]; cwd?: string }> = [];
  let closed = false;
  const instance = createCodexDesktopAdapter({
    statePath: '/codex/state.sqlite',
    worktreesDir: '/codex/worktrees',
    machine: 'laptop',
    now: () => NOW,
    spawn: (args, options) => {
      spawned.push({ args, cwd: options?.cwd });
      const code = git.exit ?? 0;
      return {
        stdout: null,
        stderr: new Response(code ? 'fatal: already exists' : '').body,
        exited: Promise.resolve(code),
        exitCode: code,
        kill: () => {},
      };
    },
    appServer: async () => {
      if (server instanceof Error) throw server;
      return {
        call: async (method, params) => {
          calls.push([method, params]);
          return server.call?.(method, params);
        },
        close: () => {
          closed = true;
        },
      };
    },
    folderExists: (folder) => folders.includes(folder),
    gitRoot: async () => git.root ?? null,
    newId: () => 'abcd1234-0000',
  });
  return { instance, calls, spawned, closed: () => closed };
}

describe('startedThreadId', () => {
  test('reads the id from thread/start in either shape', () => {
    expect(startedThreadId({ thread: { id: 'th1' } })).toBe('th1');
    expect(startedThreadId({ threadId: 'th2' })).toBe('th2');
    expect(startedThreadId({ thread: {} })).toBeNull();
    expect(startedThreadId(null)).toBeNull();
  });
});

describe('codex-desktop start', () => {
  test('starts a named thread in the folder and sends the first turn', async () => {
    const { instance, calls, closed } = adapter({
      call: async (method) => (method === 'thread/start' ? { thread: { id: 'th1' } } : {}),
    });
    expect(await instance.start?.(request, user)).toEqual({
      ok: true,
      value: {
        ref: { adapter: 'codex-desktop', id: 'th1' },
        title: 'Bigger font',
        place,
        status: 'running',
        lastActivityAt: NOW,
        link: 'codex://threads/th1',
      },
    });
    expect(calls).toEqual([
      ['thread/start', { cwd: '/focus/dolmen' }],
      ['thread/name/set', { threadId: 'th1', name: 'Bigger font' }],
      [
        'turn/start',
        { threadId: 'th1', input: [{ type: 'text', text: 'Raise the body font to 16px.' }] },
      ],
    ]);
    expect(closed()).toBe(true);
  });

  test('starts a thread in a git repo in its own detached worktree', async () => {
    const { instance, calls, spawned } = adapter(
      { call: async (method) => (method === 'thread/start' ? { thread: { id: 'th1' } } : {}) },
      ['/focus/dolmen'],
      { root: '/focus/dolmen' }
    );
    expect(await instance.start?.(request, user)).toMatchObject({ ok: true, value: { place } });
    expect(spawned).toEqual([
      {
        args: ['git', 'worktree', 'add', '--detach', '/codex/worktrees/abcd1234/dolmen', 'HEAD'],
        cwd: '/focus/dolmen',
      },
    ]);
    expect(calls[0]).toEqual(['thread/start', { cwd: '/codex/worktrees/abcd1234/dolmen' }]);
  });

  test('runs a subfolder start at the worktree root', async () => {
    const { instance, calls } = adapter(
      { call: async (method) => (method === 'thread/start' ? { thread: { id: 'th1' } } : {}) },
      ['/focus/dolmen/web'],
      { root: '/focus/dolmen' }
    );
    await instance.start?.(
      { ...request, place: { ...place, folder: '/focus/dolmen/web', name: 'web' } },
      user
    );
    expect(calls[0]).toEqual(['thread/start', { cwd: '/codex/worktrees/abcd1234/dolmen' }]);
  });

  test('removes the worktree when no thread starts', async () => {
    const { instance, spawned } = adapter({ call: async () => ({}) }, ['/focus/dolmen'], {
      root: '/focus/dolmen',
    });
    expect(await instance.start?.(request, user)).toMatchObject({ ok: false });
    expect(spawned.map(({ args }) => args.slice(0, 3))).toEqual([
      ['git', 'worktree', 'add'],
      ['git', 'worktree', 'remove'],
    ]);
    expect(spawned[1].args.at(-1)).toBe('/codex/worktrees/abcd1234/dolmen');
  });

  test('does not start a thread when the worktree cannot be created', async () => {
    const { instance, calls, closed } = adapter({}, ['/focus/dolmen'], {
      root: '/focus/dolmen',
      exit: 128,
    });
    expect(await instance.start?.(request, user)).toEqual({
      ok: false,
      reason: 'not_delivered',
      detail: 'Could not create a worktree in /focus/dolmen: fatal: already exists',
    });
    expect(calls).toEqual([]);
    expect(closed()).toBe(true);
  });

  test('needs an existing folder on this machine', async () => {
    const { instance, calls } = adapter({});
    const start = (at: Record<string, string>) =>
      instance.start?.({ ...request, place: at as typeof place }, user);
    expect(await start({ machine: 'laptop', name: 'Chats' })).toMatchObject({
      reason: 'invalid_place',
    });
    expect(await start({ ...place, machine: 'imac' })).toMatchObject({ reason: 'invalid_place' });
    expect(await start({ ...place, folder: '/gone' })).toEqual({
      ok: false,
      reason: 'invalid_place',
      detail: '/gone does not exist.',
    });
    expect(calls).toEqual([]);
  });

  test('reports an absent app-server and a thread left without its first turn', async () => {
    expect(await adapter(new Error('ENOENT')).instance.start?.(request, user)).toEqual({
      ok: false,
      reason: 'unreachable',
      detail: 'The Codex app-server is not running: ENOENT',
    });
    const halfway = adapter({
      call: async (method) => {
        if (method === 'turn/start') throw new Error('turn/start: busy');
        return method === 'thread/start' ? { threadId: 'th2' } : {};
      },
    });
    expect(await halfway.instance.start?.(request, user)).toEqual({
      ok: false,
      reason: 'not_delivered',
      detail: 'turn/start: busy Thread th2 was created without its first turn.',
    });
    expect(halfway.closed()).toBe(true);
  });
});
