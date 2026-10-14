import type { WorkExecutionPreparer } from '../../../../src/lib/drivers/start-preparation';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClaudeDesktopAdapter,
  selectClaudeStartFolder,
} from '../../../../src/lib/drivers/claude-desktop-adapter';

const user = { from: 'chat', caller: { source: 'rpc' as const } };
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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-start-'));
    spawned = [];
    cwds = [];
    clock = 1_000;
    effects = [];
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function adapter(options: {
    prepareExecution?: WorkExecutionPreparer;
    openExit?: number;
    appearsAfter?: number;
    relayWrites?: boolean;
    twin?: boolean;
    checkout?: { repo: string; linked: boolean };
    resumeExit?: number;
  }) {
    const transcripts = join(dir, 'projects', '-focus-dolmen');
    mkdirSync(transcripts, { recursive: true });
    let polls = 0;
    return createClaudeDesktopAdapter({
      sessionsDir: join(dir, 'sessions'),
      prepareExecution: options.prepareExecution,
      projectsDir: join(dir, 'projects'),
      machine: 'laptop',
      liveSessions: async () => {
        effects.push('liveSessions');
        polls++;
        return options.appearsAfter !== undefined && polls > options.appearsAfter
          ? [
              { sessionId: 'u1', status: 'idle', name: 'Bigger font' },
              ...(options.twin
                ? [{ sessionId: 'other', status: 'idle', name: 'Bigger font' }]
                : []),
            ]
          : [];
      },
      spawn: (args, spawnOptions) => {
        spawned.push(args);
        cwds.push(spawnOptions?.cwd);
        const relay = args.includes('SendMessage ListAgents');
        if (relay && options.relayWrites) {
          appendFileSync(
            join(transcripts, 'u1.jsonl'),
            `${JSON.stringify({ type: 'user', uuid: 'u-brief', message: { content: '<cross-session-message from="x">\nRaise the body font to 16px.\n</cross-session-message>' } })}\n`
          );
        }
        const code =
          args[2] === '--session-id'
            ? (options.openExit ?? 0)
            : args[2] === '--resume'
              ? (options.resumeExit ?? 0)
              : 0;
        return {
          stdout: null,
          stderr: new Response(code ? 'no auth' : '').body,
          exited: Promise.resolve(code),
          exitCode: code,
          kill: () => {},
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
        await adapter({}).start?.({ ...request, createFolder: true, ...configuration }, user)
      ).toMatchObject({ ok: false, reason });
      expect(effects).toEqual([]);
      expect(spawned).toEqual([]);
    }
  );

  test('uses the prepared directory for CLI creation and desktop without --worktree', async () => {
    const driver = adapter({
      appearsAfter: 0,
      relayWrites: true,
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
    expect(cwds[0]).toBe('/fresh/remote-base');
    expect(cwds[1]).toBe('/fresh/remote-base');
    expect(spawned[0]).not.toContain('--worktree');
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

  test('opens a named session, hands it to the app and relays the task', async () => {
    expect(await adapter({ appearsAfter: 0, relayWrites: true }).start?.(request, user)).toEqual({
      ok: true,
      value: {
        ref: { adapter: 'claude-desktop', id: 'local_u1' },
        title: 'Bigger font',
        place,
        status: 'running',
        lastActivityAt: 1_000,
        link: 'claude://claude.ai/epitaxy/local_u1',
        receipt: { executionId: 'u1', inputId: 'u-brief' },
      },
    });
    expect(spawned[0]).toEqual([
      'claude',
      '-p',
      '--session-id',
      'u1',
      '-n',
      'Bigger font',
      '--',
      'HyperNeo is handing you a task; it arrives in the next message. Reply only: ready.',
    ]);
    expect(spawned[1]).toEqual([
      'script',
      '-q',
      '/dev/null',
      'claude',
      '--desktop',
      '--resume',
      'u1',
    ]);
    expect(spawned[2].at(-1)).toContain('session named "Bigger font"');
  });

  test('relays the task from the permission class the app opened the session in', async () => {
    mkdirSync(join(dir, 'sessions', 'acct', 'scope'), { recursive: true });
    writeFileSync(
      join(dir, 'sessions', 'acct', 'scope', 'local_u1.json'),
      JSON.stringify({
        sessionId: 'local_u1',
        cliSessionId: 'u1',
        cwd: '/focus/dolmen',
        title: 'Bigger font',
        permissionMode: 'bypassPermissions',
      })
    );
    await adapter({ appearsAfter: 0, relayWrites: true }).start?.(request, user);
    expect(spawned[2].slice(6, 8)).toEqual(['--permission-mode', 'bypassPermissions']);
  });

  test('opens work in a git repo in its own worktree and resumes it there', async () => {
    await adapter({ appearsAfter: 0, checkout: { repo: '/focus/dolmen', linked: false } }).start?.(
      request,
      user
    );
    expect(spawned[0]).toEqual([
      'claude',
      '-p',
      '--session-id',
      'u1',
      '-n',
      'Bigger font',
      '--worktree',
      'neo-u1',
      '--',
      'HyperNeo is handing you a task; it arrives in the next message. Reply only: ready.',
    ]);
    expect(cwds.slice(0, 2)).toEqual(['/focus/dolmen', '/focus/dolmen/.claude/worktrees/neo-u1']);
  });

  test('runs work in a folder that is already a linked worktree without making another', async () => {
    await adapter({
      appearsAfter: 0,
      checkout: { repo: '/focus/main', linked: true },
    }).start?.(request, user);
    expect(spawned[0]).not.toContain('--worktree');
    expect(cwds.slice(0, 2)).toEqual(['/focus/dolmen', '/focus/dolmen']);
  });

  test('refuses to relay when another live session has the same name', async () => {
    expect(await adapter({ appearsAfter: 0, twin: true }).start?.(request, user)).toEqual({
      ok: false,
      reason: 'not_delivered',
      detail:
        'local_u1 was created, but the task did not reach it: Bigger font has no unique name to relay a message to.',
    });
    expect(spawned).toHaveLength(2);
  });

  test('stops when the opening turn fails', async () => {
    expect(await adapter({ openExit: 1 }).start?.(request, user)).toEqual({
      ok: false,
      reason: 'not_delivered',
      detail: 'no auth',
    });
    expect(spawned).toHaveLength(1);
  });

  test('sends the task to a session the app has not started yet, which wakes it', async () => {
    expect(await adapter({}).start?.(request, user)).toMatchObject({
      ok: true,
      value: { ref: { adapter: 'claude-desktop', id: 'local_u1' }, status: 'running' },
    });
    expect(spawned[2]).toEqual(['claude', '-p', '--resume', 'u1', '--', request.message]);
    expect(clock).toBe(1_000);
  });

  test('reports not_delivered only when that send fails', async () => {
    expect(await adapter({ resumeExit: 1 }).start?.(request, user)).toEqual({
      ok: false,
      reason: 'not_delivered',
      detail: 'local_u1 was created, but the task did not reach it: no auth',
    });
  });
});
