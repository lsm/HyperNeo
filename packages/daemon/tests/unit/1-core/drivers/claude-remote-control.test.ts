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
  runClaudeDesktopWake,
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
    permissionMode: 'auto',
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

describe('runClaudeRemoteControlRequest, openRcToggle and runClaudeDesktopWake', () => {
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
      listProcesses: async () =>
        live
          .filter((session) => session.owner === 'cli')
          .map((session) => ({
            pid: session.pid!,
            ppid: 1,
            elapsedSeconds: 1,
            command: 'claude --permission-mode auto',
          })),
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
          const id = args[args.indexOf('--resume') + 1];
          if (id === 'new-rc')
            write({
              ...record(id),
              cliSessionId: id,
              title: 'desktop-wake',
              cwd: '/Users/test',
              permissionMode: 'acceptEdits',
            });
          live.push({
            sessionId: args[args.indexOf('--resume') + 1],
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

  test.each(['unknown', 'ambiguous'] as const)(
    'native wake refuses a %s target owner before opening or requesting any helper',
    async (owner) => {
      write(record('t1'));
      live =
        owner === 'ambiguous'
          ? [
              { sessionId: 'cli-t1', status: 'idle', pid: 1, owner: 'desktop' },
              { sessionId: 'cli-t1', status: 'idle', pid: 2, owner: 'desktop' },
            ]
          : [{ sessionId: 'cli-t1', status: 'idle', pid: 1, owner }];
      expect(await runClaudeDesktopWake(target, 'Do not deliver', deps())).toMatchObject({
        ok: false,
        reason: 'unreachable',
      });
      expect(spawned).toEqual([]);
    }
  );

  test('a CLI owner accepts direct inbox input without requiring Desktop ownership', async () => {
    write(record('t1'));
    live = [{ sessionId: 'cli-t1', status: 'idle', pid: 1, owner: 'cli' }];
    const context = {
      from: 'session:neo',
      caller: { source: 'internal' as const, role: 'neo' as const },
    };
    const receipt = { executionId: 'cli-t1', inputId: 'pending-input' };
    const received: string[] = [];
    const result = await runClaudeDesktopWake(
      target,
      'next task',
      {
        ...deps(),
        sendInbox: async (_id, message) => {
          received.push(message);
          return { ok: true, value: { delivered: false, receipt } };
        },
      },
      context
    );
    expect(received).toEqual(['next task']);
    expect(result).toMatchObject({
      ok: true,
      value: { delivered: false, unconfirmed: true, receipt },
    });
    expect(spawned).toEqual([]);
  });

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

  test('reports a failed auto relay after opening rc-toggle in Desktop', async () => {
    write(record('rc', { title: 'rc-toggle', cwd: '/Users/test' }));
    const outcome = await runClaudeRemoteControlRequest(target, deps(), new Map());
    expect(outcome).toMatchObject({ ok: false, reason: 'not_delivered' });
    expect(spawned[0].args[spawned[0].args.indexOf('--resume') + 1]).toBe('cli-rc');
    expect(relayed()).toContain('Please turn on Remote Control');
  });

  test('requires the existing authorized rc-toggle instead of creating a replacement', async () => {
    expect(await runClaudeRemoteControlRequest(target, deps(), new Map())).toMatchObject({
      ok: false,
      reason: 'not_delivered',
      detail: expect.stringContaining('existing authorized rc-toggle'),
    });
    expect(spawned).toEqual([]);
  });

  test('concurrent native wakes share one helper preparation and import', async () => {
    let finish!: (code: number) => void;
    const prepared = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const base = deps();
    const shared = {
      ...base,
      spawn: ((args, options) => {
        const child = base.spawn(args, options);
        return args.includes('--session-id') ? { ...child, exited: prepared } : child;
      }) as ClaudeDesktopAdapterDeps['spawn'],
    };
    const first = openRcToggle([], [], shared, 'desktop-wake');
    const second = openRcToggle([], [], shared, 'desktop-wake');
    await vi.waitFor(() =>
      expect(spawned.some((call) => call.args.includes('--session-id'))).toBe(true)
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    finish(0);
    const results = await Promise.all([first, second]);
    expect(results.every((result) => 'value' in result)).toBe(true);
    expect(spawned.filter((call) => call.args.includes('--session-id'))).toHaveLength(1);
    expect(spawned.filter((call) => call.args.includes('--desktop'))).toHaveLength(1);
    expect(await openRcToggle([], [], shared, 'desktop-wake')).toMatchObject({
      value: { record: { sessionId: 'local_new-rc' } },
    });
    expect(spawned.filter((call) => call.args.includes('--session-id'))).toHaveLength(1);
  });

  test('a fresh helper is prepared in auto mode when no mode is configured', async () => {
    await openRcToggle([], [], deps(), 'desktop-wake');
    const prepare = spawned[0].args;
    expect(prepare[prepare.indexOf('--permission-mode') + 1]).toBe('auto');
  });

  test('a stopped desktop-wake is reopened by id instead of preparing a second helper', async () => {
    const old = record('old', {
      title: 'desktop-wake',
      cwd: '/Users/test',
      permissionMode: 'bypassPermissions',
    });
    write(old);
    const result = await openRcToggle([old], [], deps(), 'desktop-wake');
    expect(result).toMatchObject({
      value: { record: { sessionId: 'local_old', permissionMode: 'bypassPermissions' } },
    });
    expect(spawned.some((call) => call.args.includes('--session-id'))).toBe(false);
    const desktopArgs = spawned.find((call) => call.args.includes('--desktop'))!.args;
    expect(desktopArgs[desktopArgs.indexOf('--resume') + 1]).toBe('cli-old');
  });

  test.each(['desktop-wake', 'rc-toggle'])(
    'a dead %s is reused without leaking replacement records',
    async (title) => {
      const old = record('old', { title, cwd: '/Users/test' });
      write(old);
      let now = 0;
      const base = deps();
      const result = await openRcToggle(
        [old],
        [],
        {
          ...base,
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
          spawn: (args, options) => {
            const child = base.spawn(args, options);
            live = [];
            return child;
          },
        },
        title
      );
      expect(result).toMatchObject({
        reason: {
          ok: false,
          reason: 'not_delivered',
          detail: expect.stringContaining(`Claude Code Desktop did not open ${title}.`),
        },
      });
      expect(spawned.filter((call) => call.args.includes('--session-id'))).toHaveLength(0);
      expect(spawned.filter((call) => call.args.includes('--desktop'))).toHaveLength(1);
    }
  );

  test.each(['auto', 'default', 'acceptEdits', 'bypassPermissions'])(
    'a live %s target receives directly using fresh mode without a helper',
    async (mode) => {
      write(
        record('t1', {
          cwd: '/Users/test',
          permissionMode: mode === 'bypassPermissions' ? 'auto' : 'bypassPermissions',
        })
      );
      live = [{ sessionId: 'cli-t1', pid: 1, name: 'target', owner: 'desktop', status: 'idle' }];
      const project = join(dir, 'projects/-Users-test');
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, 'cli-t1.jsonl'), '');
      const context = { from: 'session:origin', caller: { source: 'rpc' as const } };
      const result = await runClaudeDesktopWake(
        target,
        'Exact direct marker',
        {
          ...deps(),
          liveSessions: async () => {
            write(record('t1', { cwd: '/Users/test', permissionMode: mode }));
            return live;
          },
          sendInbox: async (id, message, receivedContext, fromMode) => {
            expect(id).toBe('cli-t1');
            expect(receivedContext).toEqual(context);
            expect(fromMode).toBe(mode === 'bypassPermissions' ? 'bypass' : 'prompting');
            writeFileSync(
              join(project, 'cli-t1.jsonl'),
              JSON.stringify({
                type: 'user',
                uuid: 'direct-input',
                message: { content: message },
              }) + '\n'
            );
            return {
              ok: true,
              value: {
                delivered: false,
                unconfirmed: true,
                receipt: { executionId: id, inputId: 'direct-input' },
              },
            };
          },
        },
        context
      );
      expect(result).toMatchObject({
        ok: true,
        value: { delivered: true, receipt: { inputId: 'direct-input' } },
      });
      expect(spawned).toEqual([]);
    }
  );

  test.each(['auto', 'default', 'acceptEdits', 'bypassPermissions'])(
    'retries an unconfirmed direct send using the freshly changed %s receiver mode',
    async (mode) => {
      const initial = record('t1', {
        cwd: '/Users/test',
        permissionMode: mode === 'bypassPermissions' ? 'auto' : 'bypassPermissions',
      });
      write(initial);
      live = [{ sessionId: 'cli-t1', pid: 1, name: 'target', owner: 'desktop', status: 'idle' }];
      const project = join(dir, 'projects/-Users-test');
      mkdirSync(project, { recursive: true });
      const transcript = join(project, 'cli-t1.jsonl');
      writeFileSync(transcript, '');
      let now = 0;
      const base = deps();
      const result = await runClaudeDesktopWake(
        target,
        'Fresh mode marker',
        {
          ...base,
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
          sendInbox: async () => {
            write({ ...initial, permissionMode: mode });
            return {
              ok: true,
              value: {
                delivered: false,
                unconfirmed: true,
                receipt: { executionId: 'cli-t1', inputId: 'held' },
              },
            };
          },
          spawn: (args, options) => {
            const child = base.spawn(args, options);
            if (args.includes('HyperNeo relay'))
              writeFileSync(
                transcript,
                JSON.stringify({
                  type: 'user',
                  uuid: 'retried',
                  content: '<cross-session-message>Fresh mode marker</cross-session-message>',
                }) + '\n'
              );
            return child;
          },
        },
        { from: 'session:origin', caller: { source: 'rpc' } }
      );
      expect(result).toMatchObject({
        ok: true,
        value: { delivered: true, receipt: { inputId: 'retried' } },
      });
      expect(spawned).toHaveLength(1);
      expect(spawned[0].args[spawned[0].args.indexOf('--permission-mode') + 1]).toBe(
        mode === 'bypassPermissions' ? mode : 'auto'
      );
    }
  );

  test.each([false, true])(
    'a failed retry reports mode and reason after inbox throws: %s',
    async (throws) => {
      write(record('t1', { cwd: '/Users/test', permissionMode: 'acceptEdits' }));
      live = [{ sessionId: 'cli-t1', pid: 1, name: 'target', owner: 'desktop', status: 'idle' }];
      const base = deps();
      const result = await runClaudeDesktopWake(
        target,
        'Refused marker',
        {
          ...base,
          sendInbox: async () => {
            if (throws) throw new Error('direct inbox exception');
            return { ok: false, reason: 'not_delivered', detail: 'direct held' };
          },
          spawn: (args, options) => ({
            ...base.spawn(args, options),
            exited: Promise.resolve(1),
            stderr: new Response('relay held').body,
          }),
        },
        { from: 'session:origin', caller: { source: 'rpc' } }
      );
      expect(result).toMatchObject({
        ok: false,
        reason: 'not_delivered',
        detail: expect.stringContaining('acceptEdits'),
      });
      if (!result.ok) expect(result.detail).toContain('relay held');
      expect(spawned).toHaveLength(1);
    }
  );

  test('a stopped auto Desktop target runs a headless turn without a warm spawn', async () => {
    write(record('t1', { cwd: '/Users/test', permissionMode: 'auto' }));
    const project = join(dir, 'projects/-Users-test');
    mkdirSync(project, { recursive: true });
    const transcript = join(project, 'cli-t1.jsonl');
    writeFileSync(transcript, '');
    const base = deps();
    const result = await runClaudeDesktopWake(
      target,
      'Cold marker',
      {
        ...base,
        spawn: (args, options) => {
          const child = base.spawn(args, options);
          if (args.includes('--resume') && !args.includes('--desktop'))
            writeFileSync(
              transcript,
              JSON.stringify({
                type: 'user',
                uuid: 'cold-input',
                message: { content: 'Cold marker' },
              }) +
                '\n' +
                JSON.stringify({
                  type: 'assistant',
                  message: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
                }) +
                '\n'
            );
          return child;
        },
      },
      { from: 'session:origin', caller: { source: 'rpc' } }
    );
    expect(result).toMatchObject({
      ok: true,
      value: { delivered: true, receipt: { inputId: 'cold-input' } },
    });
    expect(spawned).toHaveLength(1);
    const args = spawned[0].args;
    expect(args.slice(0, 6)).toEqual([
      'claude',
      '-p',
      '--resume',
      'cli-t1',
      '--permission-mode',
      'auto',
    ]);
    expect(args.slice(-2)).toEqual(['--', 'Cold marker']);
    expect(args).not.toContain('--settings');
    expect(args).not.toContain('--append-system-prompt');
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

  test.each([false, true])(
    'keeps the requested place and receipt with status capability %s',
    async (hasStatus) => {
      const place = { machine: 'laptop', folder: '/project', name: 'Human project name' };
      const initial = { ...summary, place, status: 'queued', lastActivityAt: 1 };
      const adapter = {
        id: 'claude-desktop',
        capabilities: ['start'],
        find: async () => [],
        start: async () => ({ ok: true, value: initial }),
        ...(hasStatus
          ? {
              status: async () => ({
                ok: true,
                value: {
                  ...initial,
                  place: { ...place, folder: '/project/worktree', name: 'worktree' },
                  status: 'needs_you',
                  waitingFor: 'permission prompt',
                  permissionMode: 'acceptEdits',
                  lastActivityAt: 2,
                },
              }),
            }
          : {}),
      } as unknown as WorkAdapter;
      const wrapped = withClaudeRemoteControl(
        adapter,
        {} as ClaudeDesktopAdapterDeps,
        async () => ({ ok: true, value: { delivered: false } }),
        async () => ({
          ok: true,
          value: { delivered: true, receipt: { executionId: 'target', inputId: 'native-task' } },
        })
      );
      expect(await wrapped.start!({ message: 'Task' } as never, {} as never)).toMatchObject({
        ok: true,
        value: {
          place,
          receipt: { inputId: 'native-task' },
          ...(hasStatus
            ? {
                status: 'needs_you',
                waitingFor: 'permission prompt',
                permissionMode: 'acceptEdits',
              }
            : {}),
        },
      });
    }
  );

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
      model: 'claude-opus-5-5',
      effort: 'medium',
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
      async (target, message, _deps, deliveryContext) => {
        expect(deliveryContext).toEqual(context);
        expect(target.sessionId).toBe('local_target');
        expect(message).toContain('Exact actual task');
        expect(message).toContain('Agent: claude-opus-5-5 (effort: medium) via Claude');
        order.push('native-message');
        return {
          ok: true,
          value: { delivered: true, receipt: { executionId: 'target', inputId: 'task-input' } },
        };
      }
    );
    expect(
      await wrapped.start!({ message: 'Exact actual task', provenance: true } as never, context)
    ).toMatchObject({
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
        value: {
          ref: { adapter: 'claude-desktop', id: 'local_target' },
          link: 'claude://claude.ai/epitaxy/local_target',
          title: 'Synthetic task',
        },
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
    const result = await wrapped.start!({ message: 'Synthetic task' } as never, {} as never);
    expect(result).toMatchObject({
      ok: false,
      detail: expect.stringContaining('desktop-wake is waiting for permission prompt'),
    });
    expect(!result.ok && result.detail).toContain('claude://claude.ai/epitaxy/local_target');
    expect(!result.ok && result.detail).toContain(
      JSON.stringify({ adapter: 'claude-desktop', id: 'local_target' })
    );
    expect(!result.ok && result.detail).toContain('delivery may still arrive');
    expect(rcRequests).toBe(0);
  });
});
