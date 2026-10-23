import type { WorkExecutionPreparer } from '../../../../src/lib/drivers/start-preparation';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  let inbox: string[];
  let handoffs: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-start-'));
    spawned = [];
    cwds = [];
    clock = 1_000;
    effects = [];
    killed = [];
    inbox = [];
    handoffs = 0;
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function adapter(
    options: {
      prepareExecution?: WorkExecutionPreparer;
      exit?: number;
      silent?: boolean;
      checkout?: { repo: string; linked: boolean };
      permissionMode?: string;
      importedPermissionMode?: string;
      desktop?: 'imported' | 'never';
    } = {}
  ) {
    let live: {
      sessionId: string;
      pid: number;
      owner: 'desktop' | 'cli';
      status: string;
      name: string;
    }[] = [];
    const transcriptOf = (cwd: string) =>
      join(dir, 'projects', cwd.replace(/[/.]/g, '-'), 'u1.jsonl');
    return createClaudeDesktopAdapter({
      ...(options.permissionMode ? { permissionMode: () => options.permissionMode! } : {}),
      sessionsDir: join(dir, 'sessions'),
      prepareExecution: options.prepareExecution,
      projectsDir: join(dir, 'projects'),
      machine: 'laptop',
      liveSessions: async () => {
        effects.push('liveSessions');
        return live;
      },
      sendInbox: async (sessionId, message) => {
        inbox.push(message);
        const record = JSON.parse(
          readFileSync(join(dir, 'sessions/account/scope/local_u1.json'), 'utf8')
        ) as { cwd: string };
        appendFileSync(
          transcriptOf(record.cwd),
          `${JSON.stringify({ type: 'user', uuid: 'u-task', timestamp: '2026-10-18T20:01:00.000Z', message: { content: message } })}\n`
        );
        return {
          ok: true,
          value: { delivered: true, receipt: { executionId: sessionId, inputId: 'u-task' } },
        };
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
        const desktop = options.desktop ?? 'imported';
        if (args.includes('--desktop')) handoffs++;
        if (args.includes('--desktop') && desktop !== 'never') {
          const scope = join(dir, 'sessions/account/scope');
          mkdirSync(scope, { recursive: true });
          writeFileSync(
            join(scope, 'local_u1.json'),
            JSON.stringify({
              sessionId: 'local_u1',
              cliSessionId: 'u1',
              cwd,
              title: 'Bigger font',
              lastActivityAt: clock,
              permissionMode: options.importedPermissionMode ?? 'acceptEdits',
            })
          );
        }
        if (args[1] === '-p' && !code && !options.silent)
          appendFileSync(
            join(transcripts, 'u1.jsonl'),
            `${JSON.stringify({
              type: 'user',
              uuid: 'u-open',
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

  test('B1 prepares, exits and imports before any actual task is dispatched', async () => {
    expect(await adapter().start!(request, user)).toMatchObject({
      ok: true,
      value: {
        ref: { adapter: 'claude-desktop', id: 'local_u1' },
        title: 'Bigger font',
        place,
        status: 'queued',
        permissionMode: 'acceptEdits',
        link: 'claude://claude.ai/epitaxy/local_u1',
      },
    });
    expect(spawned[0].slice(0, 8)).toEqual([
      'claude',
      '-p',
      '--session-id',
      'u1',
      '-n',
      'Bigger font',
      '--permission-mode',
      'bypassPermissions',
    ]);
    expect(spawned[0]).not.toContain('--model');
    expect(spawned[0].at(-1)).not.toContain(request.message);
    expect(spawned[1]).toEqual([
      'script',
      '-q',
      '/dev/null',
      'claude',
      '--desktop',
      '--resume',
      'u1',
    ]);
    expect(inbox).toEqual([]);
  });

  test('B1 refuses an unconfirmed import without running the task headlessly', async () => {
    expect(await adapter({ desktop: 'never' }).start!(request, user)).toMatchObject({
      ok: false,
      reason: 'not_delivered',
    });
    expect(spawned.every((args) => !args.includes(request.message))).toBe(true);
    expect(handoffs).toBe(1);
  });

  test('B1 accepts and reports the actual imported acceptEdits mode', async () => {
    expect(
      await adapter({
        permissionMode: 'bypassPermissions',
        importedPermissionMode: 'acceptEdits',
      }).start!(request, user)
    ).toMatchObject({
      ok: true,
      value: { permissionMode: 'acceptEdits', status: 'queued' },
    });
    expect(spawned.every((args) => !args.includes(request.message))).toBe(true);
    expect(inbox).toEqual([]);
  });

  test('the configured mode applies only to preparation; Desktop gets no flag', async () => {
    expect(await adapter({ permissionMode: 'acceptEdits' }).start?.(request, user)).toMatchObject({
      ok: true,
    });
    expect(spawned[0].slice(6, 8)).toEqual(['--permission-mode', 'acceptEdits']);
    expect(spawned[1].slice(4)).toEqual(['--desktop', '--resume', 'u1']);
  });

  test('status finds the started session before Desktop registers it', async () => {
    const driver = adapter({ desktop: 'never' });
    const started = await driver.start?.(request, user);
    expect(started).toMatchObject({ ok: false, reason: 'not_delivered' });
    expect(
      await driver.status!({ adapter: 'claude-desktop', id: 'local_u1' }, undefined)
    ).toMatchObject({ ok: true, value: { ref: { id: 'local_u1' }, title: 'Bigger font' } });
  });

  test('only a real Desktop record enables links in find and status', async () => {
    const driver = adapter({ desktop: 'never' });
    const started = await driver.start!(request, user);
    const ref = { adapter: 'claude-desktop', id: 'local_u1' };
    const find = () => driver.find({ includeClosed: true, limit: 20 });
    expect(started.ok).toBe(false);
    const before = (await find())
      .flatMap((group) => group.work)
      .find((work) => work.ref.id === ref.id)!;
    expect(before.link).toBeUndefined();
    expect(before.watchHint).toContain('work.status');
    const pending = await driver.status!(ref);
    expect(pending.ok && pending.value.link).toBeUndefined();
    const scope = join(dir, 'sessions/account/scope');
    mkdirSync(scope, { recursive: true });
    writeFileSync(
      join(scope, 'local_u1.json'),
      JSON.stringify({
        sessionId: ref.id,
        cliSessionId: 'u1',
        cwd: place.folder,
        title: request.title,
        lastActivityAt: clock,
      })
    );
    const registered = (await find())
      .flatMap((group) => group.work)
      .find((work) => work.ref.id === ref.id)!;
    expect(registered.link).toBe('claude://claude.ai/epitaxy/local_u1');
    expect(registered.watchHint).toBeUndefined();
    const ready = await driver.status!(ref);
    expect(ready.ok && ready.value.link).toBe(registered.link);
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
    expect(spawned[1]).not.toContain('--worktree');
  });

  test.each([{ exit: 1 }, { silent: true }])(
    'an unconfirmed Claude start releases its prepared clone: %j',
    async (failure) => {
      let released = 0;
      const driver = adapter({
        ...failure,
        prepareExecution: async () => ({
          ok: true,
          value: {
            directory: '/fresh/remote-base',
            release: async () => {
              released++;
            },
          },
        }),
      });
      const result = await driver.start!(
        { ...request, preparation: { pack: 'coding', parameters: { target: 'dev' } } },
        user
      );
      expect(result.ok).toBe(false);
      expect(released).toBe(1);
    }
  );

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
    expect(killed).toEqual([]);
  });
});
