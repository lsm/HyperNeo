import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeDesktopAdapterDeps } from '../../../../src/lib/drivers/claude-desktop-adapter';
import {
  findRcToggle,
  requireDisconnectedTarget,
  runClaudeRemoteControlRequest,
  withClaudeRemoteControl,
} from '../../../../src/lib/drivers/claude-remote-control';
import type { WorkAdapter, WorkSummary } from '../../../../src/lib/drivers/types';

function record(id: string, fields: Record<string, unknown> = {}) {
  return {
    sessionId: `local_${id}`,
    cliSessionId: `cli-${id}`,
    title: id,
    isArchived: false,
    lastActivityAt: 0,
    ...fields,
  };
}

const target = { sessionId: 'local_t1', title: 'Fix the parser' };

describe('findRcToggle', () => {
  test('prefers a live rc-toggle, then the newest, and skips archived or other sessions', () => {
    const records = [
      record('old', { title: 'rc-toggle', lastActivityAt: 9 }),
      record('live', { title: 'rc-toggle', lastActivityAt: 1 }),
      record('gone', { title: 'rc-toggle', isArchived: true, lastActivityAt: 99 }),
      record('other', { title: 'something else', lastActivityAt: 50 }),
    ];
    expect(findRcToggle(records, [{ sessionId: 'cli-live', status: 'idle' }])).toMatchObject({
      record: { sessionId: 'local_live' },
      live: true,
    });
    expect(findRcToggle(records, [])).toMatchObject({
      record: { sessionId: 'local_old' },
      live: false,
    });
    expect(findRcToggle([record('other')], [])).toBeNull();
  });
});

describe('requireDisconnectedTarget', () => {
  test('asks only for sessions whose Remote Control was never set', () => {
    expect(requireDisconnectedTarget(target, [record('t1')])).toEqual({ value: target });
    expect(requireDisconnectedTarget(target, [])).toEqual({ value: target });
    const connected = record('t1', { bridgeSessionIds: ['session_01Abc'] });
    expect('reason' in requireDisconnectedTarget(target, [connected])).toBe(true);
    const off = record('t1', { remoteControlUserEnabled: false });
    expect('reason' in requireDisconnectedTarget(target, [off])).toBe(true);
    expect('reason' in requireDisconnectedTarget({ ...target, title: 'rc-toggle' }, [])).toBe(true);
  });
});

describe('runClaudeRemoteControlRequest', () => {
  let dir: string;
  let spawned: Array<{ args: string[]; cwd?: string }>;
  let live: Array<{ sessionId: string; status: string; name?: string }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-rc-'));
    mkdirSync(join(dir, 'acct/scope'), { recursive: true });
    spawned = [];
    live = [];
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (value: Record<string, unknown>) =>
    writeFileSync(
      join(dir, 'acct/scope', `${String(value.sessionId)}.json`),
      JSON.stringify(value)
    );

  function deps(): ClaudeDesktopAdapterDeps {
    return {
      sessionsDir: dir,
      projectsDir: join(dir, 'projects'),
      machine: 'laptop',
      liveSessions: async () => live,
      folderExists: () => true,
      makeFolder: () => {},
      homeDir: '/Users/test',
      gitCheckout: async () => null,
      newId: () => 'new-rc',
      sleep: async () => {},
      now: () => 0,
      spawn: (args, options) => {
        spawned.push({ args, cwd: options?.cwd });
        if (args.includes('--desktop')) {
          live.push({ sessionId: args.at(-1) as string, status: 'idle', name: 'rc-toggle' });
        }
        return {
          stdout: new Response('').body,
          stderr: new Response('').body,
          exited: Promise.resolve(0),
          exitCode: 0,
          kill: () => {},
        };
      },
    };
  }

  const relayed = () => spawned.find((call) => call.args.includes('HyperNeo relay'))?.args.at(-1);

  test('relays the request to the live rc-toggle session', async () => {
    write(record('t1', { title: target.title }));
    write(record('rc', { title: 'rc-toggle', cwd: '/Users/test' }));
    live = [{ sessionId: 'cli-rc', status: 'idle', name: 'rc-toggle' }];
    const outcome = await runClaudeRemoteControlRequest(target, deps(), new Map());
    expect(outcome.ok).toBe(true);
    expect(spawned.some((call) => call.args.includes('--desktop'))).toBe(false);
    expect(relayed()).toContain('rc-toggle');
    expect(relayed()).toContain(
      'Please turn on Remote Control for the Claude Code session local_t1 (Fix the parser).'
    );
  });

  test('opens a closed rc-toggle in Claude Code Desktop before relaying', async () => {
    write(record('rc', { title: 'rc-toggle', cwd: '/Users/test' }));
    const outcome = await runClaudeRemoteControlRequest(target, deps(), new Map());
    expect(outcome.ok).toBe(true);
    expect(spawned[0].args.slice(-3)).toEqual(['--desktop', '--resume', 'cli-rc']);
    expect(relayed()).toContain('local_t1');
  });

  test('creates rc-toggle with its brief when there is none', async () => {
    const outcome = await runClaudeRemoteControlRequest(target, deps(), new Map());
    expect(outcome.ok).toBe(true);
    const created = spawned[0];
    expect(created.cwd).toBe('/Users/test');
    expect(created.args.slice(0, 8)).toEqual([
      'claude',
      '-p',
      '--session-id',
      'new-rc',
      '-n',
      'rc-toggle',
      '--permission-mode',
      'bypassPermissions',
    ]);
    expect(created.args.at(-1)).toContain('You are rc-toggle.');
    expect(spawned[1].args.slice(-3)).toEqual(['--desktop', '--resume', 'new-rc']);
    expect(relayed()).toContain('local_t1');
  });

  test('leaves a session that already has its Remote Control set alone', async () => {
    write(record('t1', { title: target.title, bridgeSessionIds: ['session_01Abc'] }));
    const outcome = await runClaudeRemoteControlRequest(target, deps(), new Map());
    expect(outcome.ok).toBe(false);
    expect(spawned).toEqual([]);
  });
});

describe('withClaudeRemoteControl', () => {
  const summary = {
    ref: { adapter: 'claude-desktop', id: 'local_t1' },
    title: 'Fix the parser',
  } as WorkSummary;

  test('asks for Remote Control after a start succeeds, and not after one fails', async () => {
    const asked: string[] = [];
    let ok = true;
    const adapter = {
      id: 'claude-desktop',
      capabilities: ['start'],
      find: async () => [],
      start: async () =>
        ok
          ? { ok: true as const, value: summary }
          : { ok: false as const, reason: 'not_delivered' as const, detail: 'x' },
    } as unknown as WorkAdapter;
    const wrapped = withClaudeRemoteControl(adapter, {} as ClaudeDesktopAdapterDeps, async (t) => {
      asked.push(`${t.sessionId} ${t.title}`);
      return { ok: true, value: { delivered: true } };
    });
    expect(await wrapped.start?.({} as never, {} as never)).toEqual({ ok: true, value: summary });
    ok = false;
    await wrapped.start?.({} as never, {} as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked).toEqual(['local_t1 Fix the parser']);
  });
});
