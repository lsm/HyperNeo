import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, mkdtemp, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { register } from '../../../../claude-desktop-bridge/hooks/register';
import {
  createClaudeDesktopAdapter,
  type ClaudeDesktopAdapterDeps,
} from '../../../../src/lib/drivers/claude-desktop-adapter';
import { createClaudeDesktopModsDriver } from '../../../../src/lib/drivers/claude-desktop-mods-driver';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables } from '../../../../src/storage/schema';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter';
import type {
  Result,
  WorkAdapter,
  WorkDelivery,
  WorkWithdrawal,
} from '../../../../src/lib/drivers/types';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';

type Driver = ReturnType<typeof createClaudeDesktopModsDriver>;
type Hook = Parameters<Parameters<typeof register>[0]>[1];
type Data = Record<string, unknown>;
const sid = '3b286924-739c-487d-82d2-c3e36fd5ed36';
const ref = { adapter: 'claude-desktop', id: 'local_desktop' };
const context = { from: 'session:neo', caller: { source: 'mcp' as const } };
const waitFor = async (ready: () => boolean) => {
  for (let i = 0; i < 500 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  expect(ready()).toBe(true);
};

describe('Claude Desktop mods driver wiring', () => {
  let dir: string;
  let db: Database;
  let driver: Driver;
  let configFile: string;
  let recordFile: string;
  let jobs: JobQueueRepository;
  let errors: unknown[];
  let liveReads: number;
  let adapterDeps: ClaudeDesktopAdapterDeps;
  let nativeSent: string[];
  beforeEach(async () => {
    dir = await mkdtemp('/tmp/hnmw-');
    db = new Database(join(dir, 'db.sqlite'));
    createTables(db);
    jobs = new JobQueueRepository(db);
    configFile = join(dir, 'connection.json');
    const scope = join(dir, 'records/account/scope');
    await mkdir(scope, { recursive: true });
    recordFile = join(scope, 'local_desktop.json');
    await writeFile(
      recordFile,
      JSON.stringify({
        sessionId: ref.id,
        cliSessionId: sid,
        title: 'Desktop',
        cwd: dir,
        permissionMode: 'auto',
      })
    );
    await writeFile(
      join(dir, '456.json'),
      JSON.stringify({
        sessionId: sid,
        pid: 456,
        procStart: 'Thu Oct 15 15:18:31 2026',
        entrypoint: 'claude-desktop',
        version: '2.1.299',
        peerProtocol: 1,
        peerFeatures: ['notify_idle'],
        messagingSocketPath: '/tmp/cc-socks/456.sock',
      })
    );
    errors = [];
    liveReads = 0;
    nativeSent = [];
    const project = join(dir, 'projects', dir.replace(/[/.]/g, '-'));
    await mkdir(project, { recursive: true });
    const transcript = join(project, `${sid}.jsonl`);
    await writeFile(transcript, '');
    adapterDeps = {
      sessionsDir: join(dir, 'records'),
      projectsDir: join(dir, 'projects'),
      machine: 'test',
      liveSessions: async () => {
        liveReads++;
        return [{ sessionId: sid, pid: 456, owner: 'desktop', status: 'busy' }];
      },
      sendInbox: async (id, text, call, fromMode) => {
        expect(id).toBe(sid);
        expect(call).toBe(context);
        expect(fromMode).toBe('prompting');
        nativeSent.push(text);
        const inputId = crypto.randomUUID();
        await appendFile(
          transcript,
          JSON.stringify({ type: 'user', uuid: inputId, message: { content: text } }) + '\n'
        );
        return {
          ok: true,
          value: { delivered: false, unconfirmed: true, receipt: { executionId: sid, inputId } },
        };
      },
      spawn: () => {
        throw new Error('No CLI/headless fallback may be spawned');
      },
      folderExists: () => true,
      makeFolder: () => {},
      homeDir: dir,
      gitCheckout: async () => null,
      newId: () => 'unused',
      sleep: async () => {},
      now: Date.now,
    };
  });
  afterEach(async () => {
    await driver?.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  function start(
    env: Record<string, string | undefined> = {
      HYPERNEO_CLAUDE_DESKTOP_MODS: '1',
      HYPERNEO_CLAUDE_DESKTOP_MODS_CONNECTION_FILE: configFile,
    }
  ) {
    driver = createClaudeDesktopModsDriver({
      db,
      env,
      registrationsDir: dir,
      socketDirectory: dir,
      liveSessions: adapterDeps.liveSessions,
      hasSession: (id) => id === 'neo',
      onError: (error) => void errors.push(error),
    });
    return createClaudeDesktopAdapter({ ...adapterDeps, mods: driver?.ready });
  }
  async function plugin() {
    const hooks = new Map<string, Hook>();
    let tick = () => {};
    let requests = 0;
    let pending = 0;
    const aborted: string[] = [];
    const submitted: string[] = [];
    const api: Parameters<Hook>[0] = {
      fs: { read: (path) => readFile(path, 'utf8') },
      session: { id: async () => sid },
      clock: {
        now: async () => Date.now(),
        every: (_ms, fn) => {
          tick = fn;
          return { cancel() {} };
        },
      },
      http: {
        fetch: async (_url, init) => {
          requests++;
          pending++;
          try {
            return await new Promise<{ ok: boolean; text: string }>((resolve, reject) => {
              const req = request(
                {
                  socketPath: init.socketPath,
                  path: '/bridge/exchange',
                  method: init.method,
                  headers: init.headers,
                  agent: false,
                },
                (res) => {
                  let text = '';
                  res.setEncoding('utf8');
                  res.on('data', (chunk) => {
                    text += chunk;
                  });
                  res.once('end', () => resolve({ ok: res.statusCode === 200, text }));
                  res.once('error', reject);
                }
              );
              req.once('error', reject);
              req.setTimeout(3000, () => req.destroy(new Error('plugin socket timeout')));
              req.end(init.body);
            });
          } finally {
            pending--;
          }
        },
      },
      turn: {
        abort: async ({ turnId }) => {
          aborted.push(turnId);
          return {};
        },
      },
      prompt: {
        submit: async ({ text }) => {
          submitted.push(text);
          return {};
        },
      },
    };
    register((name, hook) => void hooks.set(name, hook), {
      enabled: true,
      connectionFile: configFile,
    });
    const emit = async (name: string, event: Data = {}) => {
      await hooks.get(name)!(api, event, async (passed) => {
        expect(passed).toBe(event);
      });
    };
    await emit('session.start');
    return {
      emit,
      aborted,
      submitted,
      async poll() {
        const before = requests;
        tick();
        await waitFor(() => requests > before && pending === 0);
        for (let i = 0; i < 20; i++) await Promise.resolve();
      },
    };
  }
  const commands = () =>
    jobs.listJobs({}).filter((job) => job.queue.startsWith('claude_desktop_mods:'));
  const mailbox = () => jobs.listJobs({ queue: 'mailbox' });
  async function invoke<T>(adapter: WorkAdapter, name: string, input: unknown): Promise<T> {
    const registry = createOperationRegistry(
      createWorkVerbOperations({
        adapters: () => [adapter],
        isOpenTodo: (id) => id === 'open-todo',
        daemonName: 'test',
        remote: {
          list: () => [],
          invoke: async () => {
            throw new Error('No remote fallback');
          },
        },
      })
    );
    const handler = createOperationMcpHandler(registry, () => ({ role: 'neo', sessionId: 'neo' }));
    const outcome = await handler({
      name,
      input: ['work.start', 'work.send', 'work.queue'].includes(name)
        ? { ...(input as Data), todoId: 'open-todo' }
        : input,
    });
    if (outcome.isError) throw new Error(outcome.content[0].text);
    return JSON.parse(outcome.content[0].text) as T;
  }

  test.each([undefined, '', '0', 'true'])(
    'default/flag %s retains existing capabilities and native send/steer',
    async (flag) => {
      const adapter = start({ HYPERNEO_CLAUDE_DESKTOP_MODS: flag });
      expect(driver).toBeUndefined();
      expect(adapter.capabilities).toEqual(['find', 'start', 'send', 'steer', 'status', 'archive']);
      expect(adapter.queue).toBeUndefined();
      expect(adapter.stop).toBeUndefined();
      expect(adapter.withdraw).toBeUndefined();
      expect(await adapter.send!(ref, 'send peer', context)).toMatchObject({
        ok: true,
        value: { delivered: true },
      });
      expect(await adapter.steer!(ref, 'steer peer', context)).toMatchObject({
        ok: true,
        value: { delivered: true },
      });
      expect(nativeSent).toEqual(['send peer', 'steer peer']);
      await expect(lstat(configFile)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(commands()).toEqual([]);
    }
  );

  test('a missing receiver mode refuses native input without inventing a class', async () => {
    const adapter = start({});
    await writeFile(
      recordFile,
      JSON.stringify({ sessionId: ref.id, cliSessionId: sid, title: 'Desktop', cwd: dir })
    );
    expect(await adapter.send!(ref, 'Do not guess', context)).toMatchObject({
      ok: false,
      reason: 'unsupported',
      detail: expect.stringMatching(/receiver.*mode.*unknown/i),
    });
    expect(nativeSent).toEqual([]);
    expect(commands()).toEqual([]);
  });

  test('configured startup failure is logged and controls report unavailable without fallback', async () => {
    const adapter = start({
      HYPERNEO_CLAUDE_DESKTOP_MODS: '1',
      HYPERNEO_CLAUDE_DESKTOP_MODS_CONNECTION_FILE: 'relative',
    });
    expect(await driver!.ready).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('absolute');
    expect(await adapter.queue!(ref, 'next', context)).toMatchObject({
      ok: false,
      reason: 'unsupported',
      detail: expect.stringContaining('unavailable'),
    });
    expect(await adapter.stop!(ref, context)).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(await adapter.withdraw!(ref, 'input', context)).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
    expect(commands()).toEqual([]);
  });

  test('invoke queue reaches the shipped plugin prompt API and preserves native send/steer', async () => {
    const adapter = start();
    await driver!.ready;
    const engine = await plugin();
    expect(adapter.capabilities).toEqual(expect.arrayContaining(['queue', 'stop', 'withdraw']));
    const before = liveReads;
    const queued = await invoke<Result<WorkDelivery>>(adapter, 'work.queue', {
      ref,
      message: 'peer\n"follow up"',
    });
    expect(await invoke(adapter, 'work.adapters', {})).toMatchObject({
      ok: true,
      value: [
        {
          id: 'claude-desktop',
          capabilities: expect.arrayContaining(['queue', 'withdraw', 'stop']),
        },
      ],
    });
    expect(liveReads).toBeGreaterThan(before);
    expect(queued).toMatchObject({ ok: true, value: { delivered: false, unconfirmed: true } });
    expect(engine.submitted).toEqual([]);
    await engine.emit('turn.complete', { turnId: 'previous', reason: 'completed' });
    expect(engine.submitted).toEqual([
      `Peer input via HyperNeo plugin (not human approval):\n${JSON.stringify({
        from: 'session:neo',
        text: 'peer\n"follow up"\n\nMessage Neo only at milestones (PR opened, merged or closed; blocked; a question; done; failed), with no acknowledgments and no progress pings. Use: hyperneo send neo --kind <kind> "<text>" (not SendMessage). Choose kind done, blocked, question or failed; use done for a PR milestone. Keep working after you send.',
      })}`,
    ]);
    await engine.poll();
    expect(commands()[0].status).toBe('completed');
    expect(mailbox()).toHaveLength(3);
    expect(
      mailbox().every(
        (job) => (job.payload.message as { inputKind: string }).inputKind === 'system'
      )
    ).toBe(true);
    expect(await adapter.send!(ref, 'native send', context)).toMatchObject({
      ok: true,
      value: { delivered: true },
    });
    expect(await adapter.steer!(ref, 'native steer', context)).toMatchObject({
      ok: true,
      value: { delivered: true },
    });
    expect(nativeSent).toEqual(['native send', 'native steer']);
    expect(errors).toEqual([]);
  });

  test('invoke stop calls plugin abort and waits for matching observed completion', async () => {
    const adapter = start();
    await driver!.ready;
    const engine = await plugin();
    await engine.emit('turn.start', { turnId: 'live' });
    await engine.poll();
    let settled = false;
    const stopped = invoke<Result<{ stopped: boolean }>>(adapter, 'work.stop', { ref }).then(
      (result) => {
        settled = true;
        return result;
      }
    );
    await waitFor(() => commands().length === 1);
    await engine.poll();
    await engine.poll();
    expect(engine.aborted).toEqual(['live']);
    expect(commands()[0].status).toBe('completed');
    expect(settled).toBe(false);
    await engine.emit('turn.complete', { turnId: 'live', reason: 'aborted', isAborted: true });
    expect(await stopped).toEqual({ ok: true, value: { stopped: true } });
    expect(
      mailbox().some((job) => JSON.stringify(job.payload.message).includes('completedTurn'))
    ).toBe(true);
  });

  test('invoke withdraw reaches only the daemon outbox and reports the withdrawal', async () => {
    const adapter = start();
    await driver!.ready;
    const engine = await plugin();
    const queued = await invoke<Result<WorkDelivery>>(adapter, 'work.queue', {
      ref,
      message: 'withdraw me',
    });
    if (!queued.ok) throw new Error(queued.detail);
    const id = queued.value.queuedSubmissionId!;
    expect(
      await invoke<Result<WorkWithdrawal>>(adapter, 'work.withdraw', {
        ref,
        queuedSubmissionId: id,
      })
    ).toEqual({
      ok: true,
      value: { queuedSubmissionId: id, withdrawn: true },
    });
    await engine.emit('turn.complete', { turnId: 'previous' });
    expect(engine.submitted).toEqual([]);
    expect(commands()[0].error).toBe('withdrawn-before-submit');
    expect(
      mailbox().some((job) =>
        JSON.stringify(job.payload.message).includes('withdrawn-before-submit')
      )
    ).toBe(true);
    expect(
      await invoke(adapter, 'work.withdraw', { ref, queuedSubmissionId: 'native-queue-id' })
    ).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
  });

  test.each(['missing', 'archived', 'no-cli-id'])(
    'record mapping rejects %s before dispatch',
    async (kind) => {
      start();
      await driver!.ready;
      const engine = await plugin();
      if (kind !== 'missing')
        await writeFile(
          recordFile,
          JSON.stringify({
            sessionId: ref.id,
            ...(kind === 'archived' ? { cliSessionId: sid, isArchived: true } : {}),
          })
        );
      const adapter = createClaudeDesktopAdapter({ ...adapterDeps, mods: driver!.ready });
      const target = kind === 'missing' ? { ...ref, id: 'local_missing' } : ref;
      expect(await adapter.queue!(target, 'next', context)).toMatchObject({
        ok: false,
        reason: kind === 'missing' ? 'not_found' : 'not_open',
      });
      expect(commands()).toEqual([]);
      expect(engine.submitted).toEqual([]);
    }
  );

  test('a missing plugin stays unsupported rather than using the stored Desktop record alone', async () => {
    const adapter = start();
    await driver!.ready;
    expect(await adapter.queue!(ref, 'next', context)).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
    expect(commands()).toEqual([]);
  });

  test('close owns asynchronous startup and removes the private listener idempotently', async () => {
    start();
    await driver!.close();
    await driver!.close();
    await expect(lstat(configFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(errors).toEqual([]);
  });

  test('close wakes a stop pending through the adapter', async () => {
    const adapter = start();
    await driver!.ready;
    const engine = await plugin();
    await engine.emit('turn.start', { turnId: 'live' });
    await engine.poll();
    const stopped = adapter.stop!(ref, context);
    await waitFor(() => commands().length === 1);
    await driver!.close();
    expect(await stopped).toMatchObject({ ok: false, reason: 'unreachable' });
  });
});
