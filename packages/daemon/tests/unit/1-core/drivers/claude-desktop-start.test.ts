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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-start-'));
    spawned = [];
    cwds = [];
    clock = 1_000;
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function adapter(options: {
    openExit?: number;
    appearsAfter?: number;
    relayWrites?: boolean;
    twin?: boolean;
    checkout?: { repo: string; linked: boolean };
  }) {
    const transcripts = join(dir, 'projects', '-focus-dolmen');
    mkdirSync(transcripts, { recursive: true });
    let polls = 0;
    return createClaudeDesktopAdapter({
      sessionsDir: join(dir, 'sessions'),
      projectsDir: join(dir, 'projects'),
      machine: 'laptop',
      liveSessions: async () => {
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
            `${JSON.stringify({ type: 'user', message: { content: '<cross-session-message from="x">\nRaise the body font to 16px.\n</cross-session-message>' } })}\n`
          );
        }
        const code = args[2] === '--session-id' ? (options.openExit ?? 0) : 0;
        return {
          stdout: null,
          stderr: new Response(code ? 'no auth' : '').body,
          exited: Promise.resolve(code),
          exitCode: code,
          kill: () => {},
        };
      },
      folderExists: () => true,
      makeFolder: () => {},
      homeDir: '/Users/test',
      gitCheckout: async () => options.checkout ?? null,
      newId: () => 'u1',
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
  }

  test('opens a named session, hands it to the app and relays the task', async () => {
    expect(await adapter({ appearsAfter: 1, relayWrites: true }).start?.(request, user)).toEqual({
      ok: true,
      value: {
        ref: { adapter: 'claude-desktop', id: 'local_u1' },
        title: 'Bigger font',
        place,
        status: 'running',
        lastActivityAt: 1_000 + 2_000,
        link: 'claude://claude.ai/epitaxy/local_u1',
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
    await adapter({ appearsAfter: 1, relayWrites: true }).start?.(request, user);
    expect(spawned[2].slice(6, 8)).toEqual(['--permission-mode', 'bypassPermissions']);
  });

  test('opens work in a git repo in its own worktree and resumes it there', async () => {
    await adapter({ appearsAfter: 1, checkout: { repo: '/focus/dolmen', linked: false } }).start?.(
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
      appearsAfter: 1,
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
        'local_u1 opened, but the task did not reach it: Bigger font has no unique name to relay a message to.',
    });
    expect(spawned).toHaveLength(2);
  });

  test('stops when the opening turn fails and reports a session the app never opened', async () => {
    expect(await adapter({ openExit: 1 }).start?.(request, user)).toEqual({
      ok: false,
      reason: 'not_delivered',
      detail: 'no auth',
    });
    expect(spawned).toHaveLength(1);
    expect(await adapter({}).start?.(request, user)).toEqual({
      ok: false,
      reason: 'not_delivered',
      detail:
        'local_u1 was created but Claude Code Desktop did not open it; send the task to it with work.send.',
    });
    expect(clock).toBeGreaterThanOrEqual(1_000 + 60_000);
  });
});
