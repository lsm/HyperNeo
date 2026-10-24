import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { createClaudeDesktopModsControl } from '../../../../src/lib/drivers/claude-desktop-mods-control';
import { createClaudeDesktopModsRuntime } from '../../../../src/lib/drivers/claude-desktop-mods-runtime';
import type { createClaudeDesktopModsServer } from '../../../../src/lib/drivers/claude-desktop-mods-server';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables } from '../../../../src/storage/schema';
import { ClaudeDesktopOutboxRepository } from '../../../../src/storage/repositories/claude-desktop-outbox-repository';

type Runtime = NonNullable<Awaited<ReturnType<typeof createClaudeDesktopModsRuntime>>>;
type Deps = Parameters<typeof createClaudeDesktopModsControl>[0];
type Event = Parameters<
  Parameters<typeof createClaudeDesktopModsServer>[0]['persist']
>[0]['events'][number];
const sid = '3b286924-739c-487d-82d2-c3e36fd5ed36';
const otherSid = '4b286924-739c-487d-82d2-c3e36fd5ed36';
const context = { from: 'session:neo', caller: { source: 'mcp' as const } };
const registration = {
  sessionId: sid,
  pid: 456,
  procStart: 'Thu Oct 15 15:18:31 2026',
  entrypoint: 'claude-desktop',
  version: '2.1.299',
  peerProtocol: 1,
  peerFeatures: ['notify_idle'],
  messagingSocketPath: '/tmp/cc-socks/456.sock',
};

describe('Claude Desktop mods control', () => {
  let dir: string;
  let db: Database;
  let runtime: Runtime;
  let control: ReturnType<typeof createClaudeDesktopModsControl>;
  let deps: Deps;
  let sequence: number;
  let instanceId: string;
  let errors: unknown[];
  beforeEach(async () => {
    dir = await mkdtemp('/tmp/hnmc-');
    db = new Database(join(dir, 'db.sqlite'));
    createTables(db);
    await writeFile(join(dir, '456.json'), JSON.stringify(registration));
    errors = [];
    sequence = 0;
    instanceId = `${sid}:1000:1`;
    runtime = (await createClaudeDesktopModsRuntime({
      db,
      env: {
        HYPERNEO_CLAUDE_DESKTOP_MODS: '1',
        HYPERNEO_CLAUDE_DESKTOP_MODS_CONNECTION_FILE: join(dir, 'connection.json'),
      },
      socketDirectory: dir,
      registrationsDir: dir,
      liveSessions: async () => [{ sessionId: sid, pid: 456, owner: 'desktop', status: 'busy' }],
      onExchange: async (id) => control?.report(id),
      onError: (error) => void errors.push(error),
    }))!;
    deps = {
      runtime,
      registrationsDir: dir,
      liveSessions: async () => [{ sessionId: sid, pid: 456, owner: 'desktop', status: 'busy' }],
      hasSession: (id) => ['neo', 'other'].includes(id),
      stopTimeoutMs: 3000,
    };
    control = createClaudeDesktopModsControl(deps);
    await send([{ kind: 'session.start' }]);
  });
  afterEach(async () => {
    await runtime.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function send(events: Omit<Event, 'sequence'>[] = []) {
    const config = JSON.parse(await readFile(runtime.connectionFile, 'utf8'));
    const body = {
      version: 1,
      sessionId: sid,
      instanceId,
      events: events.map((event) => ({ ...event, sequence: ++sequence })),
    };
    return new Promise<{
      status: number;
      reply: {
        ack?: number;
        command?: { id: string; kind: string; from?: string; text?: string; turnId?: string };
      };
    }>((resolve, reject) => {
      const req = request(
        {
          socketPath: config.socketPath,
          path: '/bridge/exchange',
          method: 'POST',
          agent: false,
          headers: { authorization: `Bearer ${config.token}` },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.once('end', () =>
            resolve({ status: res.statusCode!, reply: text ? JSON.parse(text) : {} })
          );
          res.once('error', reject);
        }
      );
      req.once('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('socket test timeout')));
      req.end(JSON.stringify(body));
    });
  }
  const mailbox = () => runtime.outbox.jobs.listJobs({ queue: 'mailbox', limit: 1000 });
  const commands = () =>
    runtime.outbox.jobs.listJobs({}).filter((job) => job.queue.startsWith('claude_desktop_mods:'));
  const facts = () =>
    mailbox().map((job) => {
      const entry = job.payload.message as { message: { content: string } };
      return JSON.parse(entry.message.content.split(': ').slice(1).join(': ')) as Record<
        string,
        unknown
      >;
    });
  async function stopPending() {
    let settled = false;
    const result = control.stop(sid, context).then((value) => {
      settled = true;
      return value;
    });
    for (let i = 0; i < 100 && !commands().length && !settled; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(settled).toBe(false);
    return { result, settled: () => settled };
  }

  test('queues durable peer input without claiming execution and reports only state changes', async () => {
    const result = await control.queue(sid, 'peer\n"text"', context);
    expect(result).toMatchObject({ ok: true, value: { delivered: false, unconfirmed: true } });
    if (!result.ok) throw new Error(result.detail);
    expect(
      runtime.outbox.get(sid, context.from, result.value.queuedSubmissionId!)?.payload.text
    ).toBe('peer\n"text"');
    expect(facts()).toEqual([expect.objectContaining({ operation: 'submit', status: 'pending' })]);
    await control.report(sid);
    expect(mailbox()).toHaveLength(1);
    const response = await send([{ kind: 'turn.complete', turnId: 'old', reason: 'completed' }]);
    expect(response.reply.command).toMatchObject({
      id: result.value.queuedSubmissionId,
      from: context.from,
      text: 'peer\n"text"',
    });
    await send([
      { kind: 'command.resolved', commandId: result.value.queuedSubmissionId!, result: {} },
    ]);
    expect(
      facts()
        .map((fact) => fact.status)
        .sort()
    ).toEqual(['completed', 'pending', 'processing']);
    for (const job of mailbox()) {
      expect(job.payload.to).toEqual({ kind: 'session', sessionId: 'neo' });
      expect(job.payload.origin).toBe(`driver:claude-desktop:${sid}`);
      expect(job.payload.messageUuid).toMatch(/^[0-9a-f]{64}$/);
      expect(job.payload.message).toMatchObject({ inputKind: 'system' });
    }
    await send([{ kind: 'turn.start', turnId: 'unrelated-later' }]);
    expect(mailbox()).toHaveLength(3);
  });

  test('withdraws only own unclaimed input even after Desktop disappears', async () => {
    const queued = await control.queue(sid, 'next', context);
    if (!queued.ok) throw new Error(queued.detail);
    const id = queued.value.queuedSubmissionId!;
    deps.liveSessions = async () => {
      throw new Error('must not probe to withdraw');
    };
    expect(await control.withdraw(sid, id, context)).toEqual({
      ok: true,
      value: { queuedSubmissionId: id, withdrawn: true },
    });
    expect(await control.withdraw(sid, id, context)).toEqual({
      ok: true,
      value: { queuedSubmissionId: id, withdrawn: true },
    });
    expect(facts()).toContainEqual(
      expect.objectContaining({ status: 'dead', error: 'withdrawn-before-submit' })
    );
    expect(mailbox()).toHaveLength(2);
  });

  test('does not withdraw a different sender/session/native queue ID', async () => {
    const queued = await control.queue(sid, 'next', context);
    if (!queued.ok) throw new Error(queued.detail);
    const id = queued.value.queuedSubmissionId!;
    for (const [target, inputId, from] of [
      [otherSid, id, context.from],
      [sid, id, 'session:other'],
      [sid, 'native-queue-id', context.from],
    ])
      expect(await control.withdraw(target, inputId, { ...context, from })).toMatchObject({
        ok: false,
        reason: 'unsupported',
      });
    expect(commands()[0].status).toBe('pending');
  });

  test('cannot report a claimed input as withdrawn', async () => {
    const queued = await control.queue(sid, 'next', context);
    if (!queued.ok) throw new Error(queued.detail);
    await send([{ kind: 'turn.complete', turnId: 'previous' }]);
    expect(await control.withdraw(sid, queued.value.queuedSubmissionId!, context)).toMatchObject({
      ok: true,
      value: { withdrawn: false, reason: 'not_queued' },
    });
  });

  test('stop waits past API resolution and unrelated completion for the exact aborted turn', async () => {
    await send([{ kind: 'turn.start', turnId: 'live' }]);
    const pending = await stopPending();
    const dispatched = await send();
    const id = dispatched.reply.command!.id;
    expect(dispatched.reply.command).toMatchObject({ kind: 'stop', turnId: 'live' });
    await send([{ kind: 'command.resolved', commandId: id, result: {} }]);
    expect(pending.settled()).toBe(false);
    await send([{ kind: 'turn.complete', turnId: 'other', reason: 'aborted', isAborted: true }]);
    expect(pending.settled()).toBe(false);
    await send([{ kind: 'turn.complete', turnId: 'live', reason: 'aborted', isAborted: true }]);
    expect(await pending.result).toEqual({ ok: true, value: { stopped: true } });
    expect(facts()).toContainEqual(
      expect.objectContaining({
        completedTurn: expect.objectContaining({ turnId: 'live', isAborted: true }),
      })
    );
  });

  test('a normally completed turn is not reported as stopped', async () => {
    await send([{ kind: 'turn.start', turnId: 'live' }]);
    const pending = await stopPending();
    await send([{ kind: 'turn.complete', turnId: 'live', reason: 'completed', isAborted: false }]);
    expect(await pending.result).toEqual({ ok: true, value: { stopped: false } });
  });

  test('idle stop is false and unknown turn ID is unsupported without enqueue', async () => {
    expect(await control.stop(sid, context)).toMatchObject({ ok: false, reason: 'unsupported' });
    await send([{ kind: 'turn.complete', turnId: 'previous' }]);
    expect(await control.stop(sid, context)).toEqual({ ok: true, value: { stopped: false } });
    expect(commands()).toEqual([]);
  });

  test('a rejected abort is a failed transport fact rather than success', async () => {
    await send([{ kind: 'turn.start', turnId: 'live' }]);
    const pending = await stopPending();
    const dispatched = await send();
    await send([
      { kind: 'command.rejected', commandId: dispatched.reply.command!.id, reason: 'stale turn' },
    ]);
    expect(await pending.result).toMatchObject({ ok: false, reason: 'not_delivered' });
    expect(facts()).toContainEqual(
      expect.objectContaining({ status: 'dead', error: 'stale turn' })
    );
  });

  test('timeout never claims termination or silently retries the stop', async () => {
    deps.stopTimeoutMs = 10;
    await send([{ kind: 'turn.start', turnId: 'live' }]);
    expect(await control.stop(sid, context)).toMatchObject({
      ok: false,
      reason: 'unreachable',
      detail: expect.stringContaining('unconfirmed'),
    });
    expect(commands()).toHaveLength(1);
    expect(commands()[0].maxRetries).toBe(0);
  });

  test('new plugin instance fences a pending stop and quarantines its old claim', async () => {
    await send([{ kind: 'turn.start', turnId: 'live' }]);
    const pending = await stopPending();
    await send();
    instanceId = `${sid}:2000:2`;
    sequence = 0;
    await send([{ kind: 'session.start' }]);
    expect(await pending.result).toMatchObject({ ok: false });
    expect(commands()[0].error).toContain('not replayed');
  });

  test('runtime close wakes stop without waiting for timeout', async () => {
    await send([{ kind: 'turn.start', turnId: 'live' }]);
    const pending = await stopPending();
    await runtime.close();
    expect(await pending.result).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  test.each(['missing', 'cli', 'ambiguous', 'unknown'])(
    'refuses %s owner without a command',
    async (kind) => {
      const row = { sessionId: sid, pid: 456, owner: 'desktop' as const, status: 'busy' };
      if (kind === 'missing') deps.liveSessions = async () => [];
      if (kind === 'ambiguous') deps.liveSessions = async () => [row, { ...row, pid: 457 }];
      if (kind === 'unknown') deps.liveSessions = async () => [{ ...row, owner: 'unknown' }];
      if (kind === 'cli') {
        deps.liveSessions = async () => [{ ...row, owner: 'cli' }];
        await writeFile(
          join(dir, '456.json'),
          JSON.stringify({ ...registration, entrypoint: 'cli', version: '2.1.295' })
        );
      }
      expect(await control.queue(sid, 'next', context)).toMatchObject({ ok: false });
      expect(commands()).toEqual([]);
    }
  );

  test('probe failure propagates without creating a command', async () => {
    deps.liveSessions = async () => {
      throw new Error('probe failed');
    };
    await expect(control.queue(sid, 'next', context)).rejects.toThrow('probe failed');
    expect(commands()).toEqual([]);
  });

  test.each(['chat', 'session:gone'])(
    'requires an available reply destination: %s',
    async (from) => {
      deps.liveSessions = async () => {
        throw new Error('must not discover');
      };
      expect(await control.queue(sid, 'next', { ...context, from })).toMatchObject({ ok: false });
      expect(commands()).toEqual([]);
    }
  );

  test('requires a recently authenticated plugin exchange, not just a stored journal', async () => {
    const now = Date.now;
    try {
      Date.now = () => now() + 6000;
      expect(runtime.connected(sid, 456)).toBe(false);
      expect(await control.queue(sid, 'next', context)).toMatchObject({
        ok: false,
        reason: 'unsupported',
      });
    } finally {
      Date.now = now;
    }
    expect(commands()).toEqual([]);
  });

  test('queue plus initial report and withdrawal plus report roll back together on mailbox failure', async () => {
    db.exec(
      "CREATE TRIGGER fail_mailbox BEFORE INSERT ON job_queue WHEN NEW.queue = 'mailbox' BEGIN SELECT RAISE(ABORT, 'mailbox unavailable'); END"
    );
    await expect(control.queue(sid, 'next', context)).rejects.toThrow('mailbox unavailable');
    expect(commands()).toEqual([]);
    db.exec('DROP TRIGGER fail_mailbox');
    const queued = await control.queue(sid, 'next', context);
    if (!queued.ok) throw new Error(queued.detail);
    db.exec(
      "CREATE TRIGGER fail_mailbox BEFORE INSERT ON job_queue WHEN NEW.queue = 'mailbox' BEGIN SELECT RAISE(ABORT, 'mailbox unavailable'); END"
    );
    await expect(control.withdraw(sid, queued.value.queuedSubmissionId!, context)).rejects.toThrow(
      'mailbox unavailable'
    );
    expect(commands()[0].status).toBe('pending');
    expect(mailbox()).toHaveLength(1);
  });

  test('report failure rolls back prior batch entries and markers, then retries without duplicates', async () => {
    for (let i = 0; i < 3; i++)
      runtime.outbox.enqueue(sid, context.from, { kind: 'submit', text: String(i) });
    db.exec(
      "CREATE TRIGGER fail_second BEFORE INSERT ON job_queue WHEN NEW.queue = 'mailbox' AND (SELECT COUNT(*) FROM job_queue WHERE queue = 'mailbox') > 0 BEGIN SELECT RAISE(ABORT, 'second report failed'); END"
    );
    await expect(control.report(sid)).rejects.toThrow('second report failed');
    expect(mailbox()).toEqual([]);
    expect(commands().every((job) => job.payload.reportState === undefined)).toBe(true);
    db.exec('DROP TRIGGER fail_second');
    await control.report(sid);
    const ids = mailbox()
      .map((job) => job.payload.messageUuid)
      .sort();
    await control.report(sid);
    expect(
      mailbox()
        .map((job) => job.payload.messageUuid)
        .sort()
    ).toEqual(ids);
    expect(ids).toHaveLength(3);
  });

  test('reports past the first page without repeated notifications', async () => {
    for (let i = 0; i < 105; i++)
      runtime.outbox.enqueue(sid, context.from, { kind: 'submit', text: String(i) });
    await control.report(sid);
    expect(mailbox()).toHaveLength(105);
    await control.report(sid);
    expect(mailbox()).toHaveLength(105);
  });

  test('report markers survive a repository reopen', async () => {
    runtime.outbox.enqueue(sid, context.from, { kind: 'submit', text: 'once' });
    await control.report(sid);
    const reopened = new Database(join(dir, 'db.sqlite'));
    try {
      new ClaudeDesktopOutboxRepository(reopened).reportChanges(sid, () => {
        throw new Error('already reported');
      });
    } finally {
      reopened.close();
    }
    expect(mailbox()).toHaveLength(1);
  });

  test('reports owner change after an abort API receipt without inventing termination', async () => {
    await send([{ kind: 'turn.start', turnId: 'live' }]);
    const pending = await stopPending();
    const dispatched = await send();
    await send([{ kind: 'command.resolved', commandId: dispatched.reply.command!.id, result: {} }]);
    instanceId = `${sid}:2000:2`;
    sequence = 0;
    await send([{ kind: 'session.start' }]);
    expect(await pending.result).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(facts()).toContainEqual(
      expect.objectContaining({ status: 'completed', ownerChanged: true })
    );
    expect(facts().some((fact) => fact.completedTurn)).toBe(false);
  });
});
