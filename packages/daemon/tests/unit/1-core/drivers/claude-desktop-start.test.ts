import type { WorkExecutionPreparer } from '../../../../src/lib/drivers/start-preparation';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { configureWorkerSandbox } from '../../../../src/lib/drivers/worker-sandbox';
import { createNodeSpawn } from '../../../../src/lib/runtime-spawn/node-backend';
import { listProcesses } from '../../../../src/lib/process-watchdog';
import { neoReadCheckoutPaths } from '../../../../src/lib/neo/read-access';
import {
  createClaudeDesktopAdapter,
  launchInClaudeDesktop,
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
    configureWorkerSandbox(() => 'always');
    dir = mkdtempSync(join(tmpdir(), 'claude-start-'));
    spawned = [];
    cwds = [];
    clock = 1_000;
    effects = [];
    killed = [];
    inbox = [];
    handoffs = 0;
    vi.stubEnv('HYPERNEO_DATA_DIR', join(dir, 'data'));
    mkdirSync(join(dir, 'prepared/.git/info'), { recursive: true });
  });

  afterEach(() => {
    configureWorkerSandbox(() => 'off');
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  function adapter(
    options: {
      prepareExecution?: WorkExecutionPreparer;
      exit?: number;
      silent?: boolean;
      checkout?: { repo: string; linked: boolean };
      permissionMode?: string;
      importedPermissionMode?: string;
      desktop?: 'imported' | 'never' | 'hung';
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
          exited:
            args.includes('--desktop') && desktop === 'hung'
              ? new Promise<number>(() => {})
              : Promise.resolve(code),
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
      'auto',
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

  test('a hung Desktop handoff has a bounded refusal and clears its timer', async () => {
    vi.useFakeTimers();
    try {
      const result = adapter({ desktop: 'hung' }).start!(request, user);
      await vi.waitFor(() => expect(handoffs).toBe(1));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await result).toMatchObject({
        ok: false,
        reason: 'not_delivered',
        detail: expect.stringContaining('Desktop handoff failed'),
      });
      expect(killed).toEqual(['SIGKILL']);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a real script handoff timeout terminates its separate-PTY child too', async () => {
    const pidFile = join(dir, 'owned-child.pid');
    let wrapperPid: number | undefined;
    let childPid: number | undefined;
    const nativeSpawn = createNodeSpawn();
    vi.useFakeTimers();
    try {
      const result = launchInClaudeDesktop('synthetic-hung', dir, {
        spawn: (_args, options) => {
          const command = `trap '' HUP; echo $$ > "${pidFile}"; exec sleep 300`;
          const child = nativeSpawn(
            process.platform === 'darwin'
              ? ['script', '-q', '/dev/null', '/bin/sh', '-c', command]
              : ['script', '-q', '-c', command, '/dev/null'],
            options
          );
          wrapperPid = child.pid;
          return child;
        },
      });
      await vi.waitFor(() => {
        childPid = Number(readFileSync(pidFile, 'utf8'));
      });
      const before = await listProcesses();
      expect(before.find((p) => p.pid === childPid)?.ppid).toBe(wrapperPid);
      await vi.advanceTimersByTimeAsync(120_000);
      vi.useRealTimers();
      expect(await result).not.toBe(0);
      await vi.waitFor(
        async () => {
          const remaining = await listProcesses();
          expect(
            remaining.some((p) => p.pid === childPid && !p.command.includes('<defunct>'))
          ).toBe(false);
        },
        { timeout: 2000 }
      );
    } finally {
      vi.useRealTimers();
      for (const pid of [childPid, wrapperPid]) {
        if (pid) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {}
        }
      }
    }
  });

  test('a confirmed prepared session survives an unconfirmed import with a recoverable location', async () => {
    let released = 0;
    const driver = adapter({
      desktop: 'never',
      prepareExecution: async () => ({
        ok: true,
        value: {
          directory: join(dir, 'prepared'),
          release: async () => {
            released++;
          },
        },
      }),
    });
    const result = await driver.start!(
      { ...request, preparation: { pack: 'coding', parameters: {} } },
      user
    );
    expect(result).toMatchObject({
      ok: false,
      detail: expect.stringContaining(join(dir, 'prepared')),
    });
    expect(!result.ok && result.detail).toContain('local_u1');
    expect(released).toBe(0);
    expect(await driver.status!({ adapter: 'claude-desktop', id: 'local_u1' })).toMatchObject({
      ok: true,
    });
  });

  test('with the worker sandbox off, a prepared start passes no sandbox settings file', async () => {
    configureWorkerSandbox(() => 'off');
    const directory = join(dir, 'prepared');
    mkdirSync(join(directory, '.git/info'), { recursive: true });
    const driver = adapter({
      prepareExecution: async () => ({ ok: true, value: { directory, release: async () => {} } }),
    });
    expect(
      (await driver.start!({ ...request, preparation: { pack: 'coding', parameters: {} } }, user))
        .ok
    ).toBe(true);
    expect(existsSync(join(directory, '.claude/settings.local.json'))).toBe(false);
    const opening = spawned.find((args) => args.includes('--session-id'))!;
    const inline = JSON.parse(opening[opening.indexOf('--settings') + 1]);
    expect(inline.env.HYPERNEO_WORKTREES).toMatch(/worktrees$/);
    expect(inline.sandbox).toBeUndefined();
    expect(opening[opening.indexOf('--append-system-prompt') + 1]).toContain('HYPERNEO_WORKTREES');
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
          directory: join(dir, 'prepared'),
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
    expect(cwds).toEqual([join(dir, 'prepared'), join(dir, 'prepared')]);
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
            directory: join(dir, 'prepared'),
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

  test.each(['missing', 'unusable'])(
    'sibling starts preserve existing policies without recreating %s runtime roots',
    async (runtimeState) => {
      const main = join(dir, 'source');
      mkdirSync(main);
      const start = async (title: string) => {
        let destination = '';
        const result = await adapter({
          prepareExecution: async (_preparation, location) => {
            destination = location.destination;
            mkdirSync(join(destination, '.git/info'), { recursive: true });
            return { ok: true, value: { directory: destination, release: async () => {} } };
          },
        }).start!(
          {
            ...request,
            title,
            place: { ...place, folder: main },
            preparation: { pack: 'coding', parameters: {} },
          },
          user
        );
        expect(result.ok).toBe(true);
        return destination;
      };
      const first = await start('First worker');
      expect(first).toBe(join(dir, 'data/claude-worktrees/source/u1'));
      const settingsPath = join(first, '.claude/settings.local.json');
      const initial = readFileSync(settingsPath, 'utf8');
      expect(JSON.parse(initial).sandbox).toMatchObject({
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        excludedCommands: [],
        filesystem: { allowWrite: expect.arrayContaining([first, join(first, '.git')]) },
      });
      expect(JSON.parse(initial).permissions).toMatchObject({
        allow: [`Edit(/${first}/**)`],
        deny: expect.arrayContaining([`Edit(/${main}/**)`]),
        disableBypassPermissionsMode: 'disable',
      });
      const sibling = join(dir, 'data/claude-worktrees/source/second');
      mkdirSync(join(sibling, '.git/info'), { recursive: true });
      const retained = JSON.parse(initial);
      retained.env.SYNTHETIC_WORKER_HINT = 'keep';
      retained.sandbox.network.allowedDomains = ['synthetic.invalid'];
      writeFileSync(settingsPath, JSON.stringify(retained));
      const firstRuntime = retained.env.TMPDIR;
      rmSync(firstRuntime, { recursive: true, force: true });
      if (runtimeState === 'unusable') writeFileSync(firstRuntime, 'unrelated runtime');
      const secondDriver = adapter({
        prepareExecution: async () => ({
          ok: true,
          value: { directory: sibling, release: async () => {} },
        }),
      });
      expect(
        (
          await secondDriver.start!(
            {
              ...request,
              place: { ...place, folder: main },
              preparation: { pack: 'coding', parameters: {} },
            },
            user
          )
        ).ok
      ).toBe(true);
      const readPolicy = (root: string) =>
        JSON.parse(readFileSync(join(root, '.claude/settings.local.json'), 'utf8'));
      expect(existsSync(firstRuntime) && statSync(firstRuntime).isDirectory()).toBe(false);
      expect(readPolicy(first).env).toEqual(retained.env);
      expect(readPolicy(first).sandbox).toEqual(retained.sandbox);
      rmSync(firstRuntime, { recursive: true, force: true });
      expect(readPolicy(first).env.TMPDIR).not.toBe(readPolicy(sibling).env.TMPDIR);
      expect(readPolicy(first).env.XDG_CACHE_HOME).not.toBe(readPolicy(sibling).env.XDG_CACHE_HOME);
      expect(readPolicy(first).permissions.deny).toContain(`Edit(/${sibling}/**)`);
      expect(readPolicy(sibling).permissions.deny).toContain(`Edit(/${first}/**)`);
      expect(readPolicy(first).permissions.deny).not.toContain(`Edit(/${first}/**)`);
      expect(
        spawned
          .filter((args) => args.includes('--desktop'))
          .every(
            (args) =>
              args.slice(0, 7).join(' ') === 'script -q /dev/null claude --desktop --resume u1' &&
              args.includes('--settings')
          )
      ).toBe(true);
      const reloaded = adapter();
      expect((await reloaded.status!({ adapter: 'claude-desktop', id: 'local_u1' })).ok).toBe(true);
      expect(readPolicy(first).permissions.deny).toContain(`Edit(/${sibling}/**)`);
    }
  );

  test.each(['legacy', 'missing', 'corrupt'])(
    'resume repairs %s prepared-worker settings before launch',
    async (state) => {
      const directory = join(dir, 'prepared');
      const driver = adapter({
        prepareExecution: async () => ({ ok: true, value: { directory, release: async () => {} } }),
      });
      expect(
        (await driver.start!({ ...request, preparation: { pack: 'coding', parameters: {} } }, user))
          .ok
      ).toBe(true);
      const path = join(directory, '.claude/settings.local.json');
      const original = JSON.parse(readFileSync(path, 'utf8'));
      if (state === 'missing') rmSync(path);
      else
        writeFileSync(
          path,
          state === 'legacy' ? JSON.stringify({ permissions: original.permissions }) : '{broken'
        );
      expect(
        (
          await driver.send!(
            { adapter: 'claude-desktop', id: 'local_u1' },
            'Synthetic legacy resume',
            user
          )
        ).ok
      ).toBe(true);
      const repaired = JSON.parse(readFileSync(path, 'utf8'));
      expect(repaired.sandbox).toMatchObject({ enabled: true, allowUnsandboxedCommands: false });
      expect(repaired.env.TMPDIR).toBe(original.env.TMPDIR);
      expect(spawned.at(-1)).toContain(path);
    }
  );

  test.each(['missing', 'corrupt'])(
    'a %s sibling policy does not block a new prepared start',
    async (state) => {
      const first = join(dir, 'prepared');
      const second = join(dir, 'sibling');
      mkdirSync(join(second, '.git/info'), { recursive: true });
      const start = async (directory: string) =>
        adapter({
          prepareExecution: async () => ({
            ok: true,
            value: { directory, release: async () => {} },
          }),
        }).start!({ ...request, preparation: { pack: 'coding', parameters: {} } }, user);
      expect((await start(first)).ok).toBe(true);
      const path = join(first, '.claude/settings.local.json');
      if (state === 'missing') rmSync(path);
      else writeFileSync(path, '{broken');
      expect((await start(second)).ok).toBe(true);
      const repaired = JSON.parse(readFileSync(path, 'utf8'));
      expect(repaired.sandbox.enabled).toBe(true);
      expect(repaired.env.TMPDIR).toBeTruthy();
    }
  );

  test('resuming a prepared worker recreates purged runtime directories and passes its policy', async () => {
    const directory = join(dir, 'prepared');
    const driver = adapter({
      prepareExecution: async () => ({ ok: true, value: { directory, release: async () => {} } }),
    });
    expect(
      (await driver.start!({ ...request, preparation: { pack: 'coding', parameters: {} } }, user))
        .ok
    ).toBe(true);
    const settings = join(directory, '.claude/settings.local.json');
    const runtime = JSON.parse(readFileSync(settings, 'utf8')).env.TMPDIR;
    rmSync(runtime, { recursive: true, force: true });
    expect(
      (await driver.send!({ adapter: 'claude-desktop', id: 'local_u1' }, 'Synthetic resume', user))
        .ok
    ).toBe(true);
    expect(existsSync(runtime)).toBe(true);
    expect(spawned.at(-1)).toContain(settings);
  });

  test('worker repository contents cannot grant Neo write access into a prepared clone', async () => {
    const readCheckout = join(dir, 'data/worktrees/acme/demo/neo-read');
    mkdirSync(readCheckout, { recursive: true });
    const result = await adapter({
      prepareExecution: async (_preparation, { destination }) => {
        mkdirSync(join(destination, '.git/info'), { recursive: true });
        mkdirSync(join(destination, 'neo-read'));
        return { ok: true, value: { directory: destination, release: async () => {} } };
      },
    }).start!({ ...request, preparation: { pack: 'coding', parameters: {} } }, user);
    expect(result.ok).toBe(true);
    expect(neoReadCheckoutPaths()).toEqual([readCheckout]);
  });

  test('preparing from a linked checkout also protects its main repository', async () => {
    const main = join(dir, 'main');
    const source = join(dir, 'linked');
    const worker = join(dir, 'prepared');
    const result = await adapter({
      checkout: { repo: main, linked: true },
      prepareExecution: async () => ({
        ok: true,
        value: { directory: worker, release: async () => {} },
      }),
    }).start!(
      {
        ...request,
        place: { ...place, folder: source },
        preparation: { pack: 'coding', parameters: {} },
      },
      user
    );
    expect(result.ok).toBe(true);
    const policy = JSON.parse(readFileSync(join(worker, '.claude/settings.local.json'), 'utf8'));
    expect(policy.permissions.deny).toContain(`Edit(/${main}/**)`);
    expect(policy.permissions.deny).toContain(`Edit(/${source}/**)`);
  });

  test('a native-policy setup failure is visible and releases only the unused clone', async () => {
    let released = 0;
    const prepared = join(dir, 'prepared');
    mkdirSync(join(prepared, '.claude'));
    const settings = join(prepared, '.claude/settings.local.json');
    mkdirSync(settings);
    writeFileSync(join(settings, 'sentinel'), 'do not overwrite');
    const result = await adapter({
      prepareExecution: async () => ({
        ok: true,
        value: {
          directory: prepared,
          release: async () => {
            released++;
          },
        },
      }),
    }).start!({ ...request, preparation: { pack: 'coding', parameters: {} } }, user);
    expect(result).toMatchObject({
      ok: false,
      reason: 'preparation_failed',
      detail: expect.stringContaining('native write policy'),
    });
    expect(readFileSync(join(settings, 'sentinel'), 'utf8')).toBe('do not overwrite');
    expect(spawned).toEqual([]);
    expect(released).toBe(1);
  });

  test('a repository symlink cannot redirect policy creation outside its clone', async () => {
    const prepared = join(dir, 'prepared');
    const outside = join(dir, 'outside-config');
    mkdirSync(outside);
    symlinkSync(outside, join(prepared, '.claude'), 'dir');
    const result = await adapter({
      prepareExecution: async () => ({
        ok: true,
        value: { directory: prepared, release: async () => {} },
      }),
    }).start!({ ...request, preparation: { pack: 'coding', parameters: {} } }, user);
    expect(result).toMatchObject({
      ok: false,
      reason: 'preparation_failed',
      detail: expect.stringContaining('in-clone .claude'),
    });
    expect(spawned).toEqual([]);
    expect(() => readFileSync(join(outside, 'settings.local.json'))).toThrow();
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

  test('keeps a shared non-coding home in place despite its Git parent', async () => {
    expect(
      await adapter({ checkout: { repo: '/focus', linked: false } }).start?.(
        { ...request, inPlace: true },
        user
      )
    ).toMatchObject({ ok: true });
    expect(spawned[0]).not.toContain('--worktree');
    expect(cwds).toEqual(['/focus/dolmen', '/focus/dolmen']);
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
