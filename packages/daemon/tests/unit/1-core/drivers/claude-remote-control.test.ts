import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { ClaudeDesktopAdapterDeps } from '../../../../src/lib/drivers/claude-desktop-adapter';
import {
  findRcToggle,
  openRcToggle,
  requireDisconnectedTarget,
  runClaudeRemoteControlRequest,
  withClaudeRemoteControl,
} from '../../../../src/lib/drivers/claude-remote-control';
import type { WorkAdapter, WorkSummary } from '../../../../src/lib/drivers/types';
import { Logger } from '../../../../src/lib/logger';

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

describe('runClaudeRemoteControlRequest and openRcToggle', () => {
  let dir: string;
  let spawned: Array<{ args: string[]; cwd?: string }>;
  let live: Array<{
    sessionId: string;
    status: string;
    name?: string;
    pid?: number;
    owner?: 'desktop' | 'cli' | 'unknown';
  }>;

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
          const id = args.at(-1) as string;
          if (id === 'new-rc')
            write({
              ...record(id),
              cliSessionId: id,
              title: 'desktop-wake',
              cwd: '/Users/test',
              permissionMode: 'acceptEdits',
            });
          live.push({
            sessionId: args.at(-1) as string,
            status: 'idle',
            name: 'rc-toggle',
            pid: 1,
            owner: 'desktop',
          });
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

  test('refuses a CLI-owned RC helper without sending or changing its permissions', async () => {
    write(record('rc', { title: 'rc-toggle', cwd: '/Users/test' }));
    live = [{ sessionId: 'cli-rc', status: 'idle', pid: 1, owner: 'cli' }];
    let sends = 0;
    expect(
      await runClaudeRemoteControlRequest(
        target,
        {
          ...deps(),
          sendInbox: async () => {
            sends++;
            return { ok: true, value: { delivered: true } };
          },
        },
        new Map()
      )
    ).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(sends).toBe(0);
    expect(spawned).toEqual([]);
  });

  test('refuses a CLI relay after opening rc-toggle in Desktop', async () => {
    write(record('rc', { title: 'rc-toggle', cwd: '/Users/test' }));
    const outcome = await runClaudeRemoteControlRequest(target, deps(), new Map());
    expect(outcome).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(spawned[0].args.slice(-3)).toEqual(['--desktop', '--resume', 'cli-rc']);
    expect(relayed()).toBeUndefined();
  });

  test('requires the existing authorized rc-toggle instead of creating a replacement', async () => {
    expect(await runClaudeRemoteControlRequest(target, deps(), new Map())).toMatchObject({
      ok: false,
      reason: 'not_delivered',
      detail: expect.stringContaining('existing authorized rc-toggle'),
    });
    expect(spawned).toEqual([]);
  });

  test('a stopped forwarding helper retains its history while a fresh acceptEdits helper is prepared', async () => {
    const old = record('old', {
      title: 'desktop-wake',
      cwd: '/Users/test',
      permissionMode: 'acceptEdits',
    });
    write(old);
    const oldPath = join(dir, 'acct/scope/local_old.json');
    const bytes = readFileSync(oldPath, 'utf8');
    const result = await openRcToggle([old], [], deps(), 'desktop-wake');
    expect(result).toMatchObject({
      value: { record: { sessionId: 'local_new-rc', permissionMode: 'acceptEdits' } },
    });
    expect(spawned[0].args).toContain('--session-id');
    expect(spawned[0].args).toContain('acceptEdits');
    expect(spawned[0].args).not.toContain('bypassPermissions');
    expect(readFileSync(oldPath, 'utf8')).toBe(bytes);
  });

  test('leaves a session that already has its Remote Control set alone', async () => {
    write(record('t1', { title: target.title, bridgeSessionIds: ['session_01Abc'] }));
    const outcome = await runClaudeRemoteControlRequest(target, deps(), new Map());
    expect(outcome).toEqual({ ok: true, value: { delivered: false } });
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
    const context = { from: 'session:origin', caller: { source: 'internal' as const } };
    const contexts: unknown[] = [];
    let ok = true;
    const adapter = {
      id: 'claude-desktop',
      capabilities: ['start'],
      find: async () => [],
      status: async () => ({ ok: true as const, value: summary }),
      start: async () =>
        ok
          ? { ok: true as const, value: summary }
          : { ok: false as const, reason: 'not_delivered' as const, detail: 'x' },
    } as unknown as WorkAdapter;
    const wrapped = withClaudeRemoteControl(
      adapter,
      {} as ClaudeDesktopAdapterDeps,
      async (t, _deps, _cache, replyContext) => {
        contexts.push(replyContext);
        asked.push(`${t.sessionId} ${t.title}`);
        return { ok: true, value: { delivered: true } };
      },
      async () => ({ ok: true, value: { delivered: true } })
    );
    expect(await wrapped.start?.({} as never, context)).toMatchObject({ ok: true, value: summary });
    ok = false;
    await wrapped.start?.({} as never, {} as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked).toEqual(['local_t1 Fix the parser']);
    expect(contexts).toEqual([context]);
  });

  test('logs a request that fails or throws instead of dropping it', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const adapter = {
      id: 'claude-desktop',
      capabilities: ['start'],
      find: async () => [],
      status: async () => ({ ok: true as const, value: summary }),
      start: async () => ({ ok: true as const, value: summary }),
    } as unknown as WorkAdapter;
    let call = 0;
    const wrapped = withClaudeRemoteControl(
      adapter,
      {} as ClaudeDesktopAdapterDeps,
      async () => {
        call += 1;
        if (call === 2) throw new Error('desktop gone');
        return { ok: false, reason: 'not_delivered', detail: 'rc-toggle missing' };
      },
      async () => ({ ok: true, value: { delivered: true } })
    );
    await wrapped.start?.({} as never, {} as never);
    await wrapped.start?.({} as never, {} as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      'Remote Control for local_t1 was not set: not_delivered: rc-toggle missing',
      'Remote Control for local_t1 threw: desktop gone',
    ]);
    warn.mockRestore();
  });
});

describe('B1 native task delivery', () => {
  test('returns the real task receipt and actual permission wait after native delivery', async () => {
    const order: string[] = [];
    const summary = {
      ref: { adapter: 'claude-desktop', id: 'local_target' },
      title: 'Synthetic task',
      permissionMode: 'acceptEdits',
      status: 'queued',
    } as unknown as WorkSummary;
    const actual = { ...summary, status: 'needs_you', waitingFor: 'permission prompt' };
    const context = { from: 'session:origin', caller: { source: 'rpc' as const } };
    const adapter = {
      id: 'claude-desktop',
      capabilities: ['start'],
      find: async () => [],
      start: async () => {
        order.push('prepared-imported');
        return { ok: true, value: summary };
      },
      status: async () => ({ ok: true, value: actual }),
    } as unknown as WorkAdapter;
    const wrapped = withClaudeRemoteControl(
      adapter,
      {} as ClaudeDesktopAdapterDeps,
      async () => {
        order.push('rc-requested');
        return { ok: true, value: { delivered: true } };
      },
      async (target, message) => {
        expect(target.sessionId).toBe('local_target');
        expect(message).toBe('Exact actual task');
        order.push('native-message');
        return {
          ok: true,
          value: { delivered: true, receipt: { executionId: 'target', inputId: 'task-input' } },
        };
      }
    );
    expect(await wrapped.start!({ message: 'Exact actual task' } as never, context)).toMatchObject({
      ok: true,
      value: {
        permissionMode: 'acceptEdits',
        status: 'needs_you',
        waitingFor: 'permission prompt',
        receipt: { inputId: 'task-input' },
      },
    });
    expect(order.slice(0, 2)).toEqual(['prepared-imported', 'native-message']);
  });

  test('a native wake refusal is not reported as a running task or retried headlessly', async () => {
    let rcRequests = 0;
    const adapter = {
      id: 'claude-desktop',
      capabilities: ['start'],
      find: async () => [],
      start: async () => ({
        ok: true,
        value: { ref: { id: 'local_target' }, title: 'Synthetic task' },
      }),
    } as unknown as WorkAdapter;
    const wrapped = withClaudeRemoteControl(
      adapter,
      {} as ClaudeDesktopAdapterDeps,
      async () => {
        rcRequests++;
        return { ok: true, value: { delivered: true } };
      },
      async () => ({
        ok: false,
        reason: 'not_delivered',
        detail: 'desktop-wake is waiting for permission prompt',
      })
    );
    expect(await wrapped.start!({ message: 'Synthetic task' } as never, {} as never)).toMatchObject(
      {
        ok: false,
        detail: 'desktop-wake is waiting for permission prompt',
      }
    );
    expect(rcRequests).toBe(0);
  });
});
