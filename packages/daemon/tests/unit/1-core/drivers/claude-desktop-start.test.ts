import type { WorkExecutionPreparer } from '../../../../src/lib/drivers/start-preparation';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClaudeDesktopAdapter,
  selectClaudeStartFolder,
} from '../../../../src/lib/drivers/claude-desktop-adapter';

const user = { from: 'session:origin', caller: { source: 'rpc' as const } };
const place = { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen' };
const request = { place, title: 'Bigger font', message: 'Raise the body font to 16px.' };

describe('selectClaudeStartFolder', () => {
  const deps = { machine: 'laptop', folderExists: (folder: string) => folder === '/focus/dolmen' };
  const select = (at: Record<string, string>) =>
    selectClaudeStartFolder({ ...request, place: at as typeof place }, deps as never);

  test('needs an existing folder on this machine', () => {
    expect(select(place)).toEqual({ value: '/focus/dolmen' });
    expect(select({ machine: 'laptop', name: 'Chats' })).toMatchObject({
      reason: { reason: 'invalid_place' },
    });
    expect(select({ ...place, machine: 'imac' })).toMatchObject({
      reason: { reason: 'invalid_place' },
    });
    expect(select({ ...place, folder: '/gone' })).toMatchObject({
      reason: {
        detail: '/gone does not exist. To start a new project there, pass createFolder: true.',
      },
    });
  });
});

describe('claude-desktop start', () => {
  let dir: string;
  let spawned: string[][];
  let cwds: (string | undefined)[];
  let clock: number;
  let effects: string[];
  let killed: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-start-'));
    spawned = [];
    cwds = [];
    clock = 1_000;
    effects = [];
    killed = [];
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function adapter(
    options: {
      prepareExecution?: WorkExecutionPreparer;
      exit?: number;
      silent?: boolean;
      checkout?: { repo: string; linked: boolean };
    } = {}
  ) {
    return createClaudeDesktopAdapter({
      sessionsDir: join(dir, 'sessions'),
      prepareExecution: options.prepareExecution,
      projectsDir: join(dir, 'projects'),
      machine: 'laptop',
      liveSessions: async () => {
        effects.push('liveSessions');
        return [];
      },
      spawn: (args, spawnOptions) => {
        spawned.push(args);
        cwds.push(spawnOptions?.cwd);
        const code = args[1] === '-p' ? (options.exit ?? 0) : 0;
        const worktree = args[args.indexOf('--worktree') + 1];
        const cwd = args.includes('--worktree')
          ? join(spawnOptions?.cwd ?? '', '.claude', 'worktrees', worktree)
          : (spawnOptions?.cwd ?? '');
        const transcripts = join(dir, 'projects', cwd.replace(/[/.]/g, '-'));
        mkdirSync(transcripts, { recursive: true });
        if (args[1] === '-p' && !code && !options.silent)
          appendFileSync(
            join(transcripts, 'u1.jsonl'),
            `${JSON.stringify({
              type: 'user',
              uuid: 'u-task',
              timestamp: '2026-10-18T20:00:00.000Z',
              message: { content: args.at(-1) },
            })}\n`
          );
        return {
          stdout: null,
          stderr: new Response(code ? 'no auth' : '').body,
          exited: Promise.resolve(code),
          exitCode: code,
          kill: (signal?: string) => {
            killed.push(String(signal));
          },
        };
      },
      folderExists: () => {
        effects.push('folderExists');
        return true;
      },
      makeFolder: () => {
        effects.push('makeFolder');
      },
      homeDir: '/Users/test',
      gitCheckout: async () => {
        effects.push('gitCheckout');
        return options.checkout ?? null;
      },
      newId: () => {
        effects.push('newId');
        return 'u1';
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
  }

  test.each([
    [{ model: 'sonnet' }, 'unsupported_model'],
    [{ effort: 'medium' }, 'unsupported_effort'],
    [{ model: 'sonnet', effort: 'medium' }, 'unsupported_model'],
  ] as const)(
    'refuses explicit configuration %j before start effects',
    async (configuration, reason) => {
      expect(
        await adapter().start?.({ ...request, createFolder: true, ...configuration }, user)
      ).toMatchObject({ ok: false, reason });
      expect(effects).toEqual([]);
      expect(spawned).toEqual([]);
    }
  );

  test('the task itself is the first turn, then the session opens in Desktop', async () => {
    expect(await adapter().start?.(request, user)).toEqual({
      ok: true,
      value: {
        ref: { adapter: 'claude-desktop', id: 'local_u1' },
        title: 'Bigger font',
        place,
        status: 'running',
        lastActivityAt: 1_000,
        link: 'claude://claude.ai/epitaxy/local_u1',
        receipt: { executionId: 'u1', inputId: 'u-task' },
      },
    });
    expect(spawned).toEqual([
      [
        'claude',
        '-p',
        '--session-id',
        'u1',
        '-n',
        'Bigger font',
        '--permission-mode',
        'bypassPermissions',
        '--',
        'Raise the body font to 16px.',
      ],
      ['script', '-q', '/dev/null', 'claude', '--desktop', '--resume', 'u1'],
    ]);
    expect(effects).not.toContain('liveSessions');
  });

  test('status finds the started session before Desktop registers it', async () => {
    const driver = adapter();
    const started = await driver.start?.(request, user);
    expect(started).toMatchObject({ ok: true });
    expect(
      await driver.status!({ adapter: 'claude-desktop', id: 'local_u1' }, undefined)
    ).toMatchObject({ ok: true, value: { ref: { id: 'local_u1' }, title: 'Bigger font' } });
  });

  test('uses the prepared directory for CLI creation and desktop without --worktree', async () => {
    const driver = adapter({
      prepareExecution: async () => ({
        ok: true,
        value: {
          directory: '/fresh/remote-base',
          release: async () => {
            throw new Error('Live resource released');
          },
        },
      }),
    });
    await driver.start!(
      { ...request, preparation: { pack: 'coding', parameters: { target: 'dev' } } },
      user
    );
    expect(cwds).toEqual(['/fresh/remote-base', '/fresh/remote-base']);
    expect(spawned[0]).not.toContain('--worktree');
    expect(spawned[1]).not.toContain('--permission-mode');
  });

  test('failed preparation launches no Claude process', async () => {
    const driver = adapter({
      prepareExecution: async () => ({
        ok: false,
        reason: 'preparation_failed',
        detail: 'fetch failed',
      }),
    });
    expect(
      await driver.start!({ ...request, preparation: { pack: 'coding', parameters: {} } }, user)
    ).toMatchObject({ ok: false, reason: 'preparation_failed' });
    expect(spawned).toEqual([]);
  });

  test('opens work in a git repo in its own worktree and resumes it there', async () => {
    await adapter({ checkout: { repo: '/focus/dolmen', linked: false } }).start?.(request, user);
    expect(spawned[0]).toContain('--worktree');
    expect(spawned[0]).toContain('neo-u1');
    expect(cwds).toEqual(['/focus/dolmen', '/focus/dolmen/.claude/worktrees/neo-u1']);
  });

  test('runs work in a folder that is already a linked worktree without making another', async () => {
    await adapter({ checkout: { repo: '/focus/main', linked: true } }).start?.(request, user);
    expect(spawned[0]).not.toContain('--worktree');
    expect(cwds).toEqual(['/focus/dolmen', '/focus/dolmen']);
  });

  test('stops when the first turn fails to start, without opening Desktop', async () => {
    expect(await adapter({ exit: 1 }).start?.(request, user)).toEqual({
      ok: false,
      reason: 'not_delivered',
      detail: 'no auth',
    });
    expect(spawned).toHaveLength(1);
  });

  test('reports a task that never reaches the transcript', async () => {
    expect(await adapter({ silent: true }).start?.(request, user)).toEqual({
      ok: false,
      reason: 'not_delivered',
      detail: 'the message did not appear in the session transcript',
    });
    expect(spawned).toHaveLength(1);
    expect(killed).toEqual(['SIGKILL']);
  });
});
