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
    probeFails?: boolean;
    twin?: boolean;
    checkout?: { repo: string; linked: boolean };
    owner?: 'desktop' | 'cli' | 'unknown';
  }) {
    const transcripts = join(dir, 'projects', '-focus-dolmen');
    mkdirSync(transcripts, { recursive: true });
    let polls = 0;
    return createClaudeDesktopAdapter({
      sessionsDir: join(dir, 'sessions'),
      admitInbox: () => ({ value: user.from }),
      sendInbox: async () => {
        appendFileSync(
          join(transcripts, 'u1.jsonl'),
          `${JSON.stringify({ type: 'user', uuid: 'u-brief' })}\n`
        );
        return {
          ok: true,
          value: {
            delivered: false,
            unconfirmed: true,
            receipt: { executionId: 'u1', inputId: 'u-brief' },
          },
        };
      },
      prepareExecution: options.prepareExecution,
      projectsDir: join(dir, 'projects'),
      machine: 'laptop',
      liveSessions: async () => {
        effects.push('liveSessions');
        if (options.probeFails) throw new Error('agent listing unavailable');
        polls++;
        return options.appearsAfter !== undefined && polls > options.appearsAfter
          ? [
              {
                sessionId: 'u1',
                status: 'idle',
                name: 'Bigger font',
                pid: 1,
                owner: options.owner ?? 'desktop',
              },
              ...(options.twin
                ? [{ sessionId: 'other', status: 'idle', name: 'Bigger font' }]
                : []),
            ]
          : [];
      },
      spawn: (args, spawnOptions) => {
        spawned.push(args);
        cwds.push(spawnOptions?.cwd);
        const code = args[2] === '--session-id' ? (options.openExit ?? 0) : 0;
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
    expect(spawned[0]).toContain('bypassPermissions');
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

  test('sends only when the newly created session has a confirmed live CLI owner', async () => {
    expect(await adapter({ appearsAfter: 0, owner: 'cli' }).start?.(request, user)).toEqual({
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
      '--permission-mode',
      'bypassPermissions',
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
    expect(spawned).toHaveLength(2);
  });

  test('hands the new Desktop-owned session task to its verified inbox callback', async () => {
    expect(
      await adapter({ appearsAfter: 0, owner: 'desktop' }).start?.(request, user)
    ).toMatchObject({
      ok: true,
      value: { status: 'running', receipt: { executionId: 'u1', inputId: 'u-brief' } },
    });
    expect(spawned).toHaveLength(2);
    expect(spawned.some((args) => args.includes('HyperNeo relay'))).toBe(false);
  });

  test('refuses to resume or relay after Desktop ownership probing fails', async () => {
    expect(await adapter({ probeFails: true }).start?.(request, user)).toMatchObject({
      ok: false,
      reason: 'not_delivered',
      detail:
        'local_u1 was created, but the task did not reach it: Could not inspect live Claude sessions: agent listing unavailable',
    });
    expect(spawned).toHaveLength(2);
    expect(spawned[0]).toContain('--session-id');
    expect(spawned[1]).toContain('--desktop');
    expect(spawned.some((args) => args.includes('SendMessage ListAgents'))).toBe(false);
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
      '--permission-mode',
      'bypassPermissions',
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

  test('stops when the opening turn fails', async () => {
    expect(await adapter({ openExit: 1 }).start?.(request, user)).toEqual({
      ok: false,
      reason: 'not_delivered',
      detail: 'no auth',
    });
    expect(spawned).toHaveLength(1);
  });

  test('does not resume when the new session has no live owner', async () => {
    expect(await adapter({}).start?.(request, user)).toMatchObject({
      ok: false,
      reason: 'not_delivered',
      detail: expect.stringContaining('ownership is unknown'),
    });
    expect(spawned).toHaveLength(2);
    expect(spawned.some((args) => args[0] === 'claude' && args.includes('--resume'))).toBe(false);
    expect(clock).toBe(1_000);
  });

  test('reports partial creation without task delivery for an unknown live owner', async () => {
    expect(
      await adapter({ appearsAfter: 0, owner: 'unknown' }).start?.(request, user)
    ).toMatchObject({
      ok: false,
      reason: 'not_delivered',
      detail: expect.stringContaining('ownership is unknown'),
    });
    expect(spawned).toHaveLength(2);
    expect(spawned.some((args) => args.includes('HyperNeo relay'))).toBe(false);
  });
});
