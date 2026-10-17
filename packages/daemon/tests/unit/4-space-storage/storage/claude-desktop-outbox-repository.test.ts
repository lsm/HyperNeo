import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables } from '../../../../src/storage/schema';
import { ClaudeDesktopOutboxRepository } from '../../../../src/storage/repositories/claude-desktop-outbox-repository';
import { createClaudeDesktopModsServer } from '../../../../src/lib/drivers/claude-desktop-mods-server';

type Exchange = Parameters<ClaudeDesktopOutboxRepository['exchange']>[0];
type Input = Parameters<ClaudeDesktopOutboxRepository['enqueue']>[2];
const sid = '3b286924-739c-487d-82d2-c3e36fd5ed36';
const otherSid = '4b286924-739c-487d-82d2-c3e36fd5ed36';
const from = 'session:neo';
const instanceId = `${sid}:1000:1`;
const frame = (events: Exchange['events'] = [], id = instanceId): Exchange => ({
  version: 1,
  sessionId: sid,
  instanceId: id,
  events,
});
const start = frame([{ sequence: 1, kind: 'session.start' }]);

describe('ClaudeDesktopOutboxRepository', () => {
  let dir: string;
  let db: Database;
  let outbox: ClaudeDesktopOutboxRepository;
  beforeEach(async () => {
    dir = await mkdtemp('/tmp/hn-outbox-');
    db = new Database(join(dir, 'db.sqlite'));
    createTables(db);
    outbox = new ClaudeDesktopOutboxRepository(db);
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const submit = () => outbox.enqueue(sid, from, { kind: 'submit', text: 'peer\n"question"' });
  const idle = () => outbox.exchange(start, 456, true);

  test('stores exact peer input as a durable pending job with automatic retries disabled', () => {
    const job = submit();
    expect(job.payload).toEqual({ sessionId: sid, from, kind: 'submit', text: 'peer\n"question"' });
    expect(job.status).toBe('pending');
    expect(job.maxRetries).toBe(0);
    db.close();
    db = new Database(join(dir, 'db.sqlite'));
    outbox = new ClaudeDesktopOutboxRepository(db);
    expect(outbox.get(sid, from, job.id)?.payload).toEqual(job.payload);
  });

  test.each([
    { input: { kind: 'submit', text: '' } },
    { input: { kind: 'submit', text: ' ' } },
    { input: { kind: 'submit', text: 'text', asUser: true } },
    { input: { kind: 'stop', turnId: '' } },
    { input: { kind: 'withdraw', messageId: 'native' } },
  ])('does not enqueue invalid control input %j', ({ input }) => {
    expect(() => outbox.enqueue(sid, from, input as Input)).toThrow();
    expect(outbox.jobs.listJobs({})).toEqual([]);
  });

  test('unknown is not idle; inputs remain withdrawable until observed idle or turn completion', () => {
    const job = submit();
    expect(outbox.exchange(start, 456)).toEqual({ ack: 1 });
    expect(outbox.get(sid, from, job.id)?.status).toBe('pending');
    const reply = outbox.exchange(frame(), 456, true);
    expect(reply.command).toEqual({
      id: job.id,
      instanceId,
      kind: 'submit',
      from,
      text: 'peer\n"question"',
    });
    expect(outbox.get(sid, from, job.id)).toMatchObject({
      status: 'processing',
      payload: { instanceId, ownerPid: 456 },
    });
  });

  test('holds pending input while busy even if an idle probe disagrees, then dispatches FIFO', () => {
    const first = submit();
    const second = submit();
    expect(
      outbox.exchange(
        frame([...start.events, { sequence: 2, kind: 'turn.start', turnId: 'turn-a' }]),
        456,
        true
      )
    ).toEqual({ ack: 2 });
    expect(outbox.jobs.getJob(first.id)?.status).toBe('pending');
    const reply = outbox.exchange(
      frame([{ sequence: 3, kind: 'turn.complete', turnId: 'turn-a', reason: 'answer' }]),
      456
    );
    expect(reply.command?.id).toBe(first.id);
    expect(outbox.jobs.getJob(second.id)?.status).toBe('pending');
    expect(outbox.exchange(frame(), 456).command?.id).toBe(first.id);
  });

  test('stop has its own lane and progresses while a submission waits in the engine', () => {
    const input = submit();
    expect(idle().command?.id).toBe(input.id);
    outbox.exchange(frame([{ sequence: 2, kind: 'turn.start', turnId: 'turn-live' }]), 456);
    const stop = outbox.enqueue(sid, from, { kind: 'stop', turnId: 'turn-live' });
    expect(outbox.exchange(frame(), 456).command).toEqual({
      id: stop.id,
      instanceId,
      kind: 'stop',
      turnId: 'turn-live',
    });
    expect(outbox.jobs.getJob(input.id)?.status).toBe('processing');
  });

  test('a queued stop is selected before an older pending input', () => {
    const input = submit();
    const stop = outbox.enqueue(sid, from, { kind: 'stop', turnId: 'turn-live' });
    expect(idle().command?.id).toBe(stop.id);
    expect(outbox.jobs.getJob(input.id)?.status).toBe('pending');
  });

  test('reopening the daemon retransmits the same claim ID only to the same instance', () => {
    const input = submit();
    const original = idle().command;
    const claim = outbox.jobs.getJob(input.id)?.claimToken;
    db.close();
    db = new Database(join(dir, 'db.sqlite'));
    outbox = new ClaudeDesktopOutboxRepository(db);
    expect(outbox.exchange(start, 456, true).command).toEqual(original);
    expect(outbox.jobs.getJob(input.id)?.claimToken).toBe(claim);
    expect(outbox.jobs.listJobs({})).toHaveLength(1);
  });

  test('a new instance quarantines uncertain claims and may dispatch only untouched pending input', () => {
    const uncertain = submit();
    const pending = submit();
    idle();
    const next = `${sid}:2000:1`;
    const reply = outbox.exchange(frame(start.events, next), 457, true);
    expect(reply.command?.id).toBe(pending.id);
    expect(reply.command?.instanceId).toBe(next);
    expect(outbox.jobs.getJob(uncertain.id)).toMatchObject({
      status: 'dead',
      error: 'unknown-previous-dispatch; not replayed',
    });
    expect(() => outbox.exchange(frame(), 456, true)).toThrow('instance or owner changed');
    expect(outbox.jobs.getJob(pending.id)?.payload.instanceId).toBe(next);
  });

  test('generic lease reclamation cannot turn a dispatched input into a withdrawable or replayable one', () => {
    const job = submit();
    idle();
    outbox.jobs.reclaimStale(Date.now() + 1000);
    expect(outbox.jobs.getJob(job.id)?.status).toBe('pending');
    expect(outbox.withdraw(sid, from, job.id)).toMatchObject({
      ok: true,
      value: { withdrawn: false, reason: 'not_queued' },
    });
    expect(outbox.exchange(frame(), 456, true)).toEqual({ ack: 1 });
    expect(outbox.jobs.getJob(job.id)?.status).toBe('dead');
  });

  test('withdraw wins before claim and remains idempotent after reopen', () => {
    const job = submit();
    expect(outbox.withdraw(sid, from, job.id)).toEqual({
      ok: true,
      value: { queuedSubmissionId: job.id, withdrawn: true },
    });
    expect(idle()).toEqual({ ack: 1 });
    db.close();
    db = new Database(join(dir, 'db.sqlite'));
    outbox = new ClaudeDesktopOutboxRepository(db);
    expect(outbox.withdraw(sid, from, job.id)).toMatchObject({ value: { withdrawn: true } });
  });

  test('claim wins before withdraw without claiming native queue cancellation', () => {
    const job = submit();
    idle();
    expect(outbox.withdraw(sid, from, job.id)).toEqual({
      ok: true,
      value: { queuedSubmissionId: job.id, withdrawn: false, reason: 'not_queued' },
    });
    expect(outbox.jobs.getJob(job.id)?.status).toBe('processing');
  });

  test('withdraw cannot touch another sender, session, control job or native queue ID', () => {
    const input = submit();
    const control = outbox.enqueue(sid, from, { kind: 'stop', turnId: 'turn' });
    for (const [session, sender, id] of [
      [sid, 'session:other', input.id],
      [otherSid, from, input.id],
      [sid, from, control.id],
      [sid, from, 'native-id'],
    ]) {
      expect(outbox.withdraw(session, sender, id)).toMatchObject({
        ok: false,
        reason: 'unsupported',
      });
    }
    expect(outbox.jobs.getJob(input.id)?.status).toBe('pending');
    expect(outbox.jobs.getJob(control.id)?.status).toBe('pending');
  });

  test.each(['command.resolved', 'command.rejected'] as const)(
    'records scoped %s facts without converting them into observed turn completion',
    (kind) => {
      const job = outbox.enqueue(sid, from, { kind: 'stop', turnId: 'turn-live' });
      outbox.exchange(
        frame([...start.events, { sequence: 2, kind: 'turn.start', turnId: 'turn-live' }]),
        456
      );
      outbox.exchange(
        frame([
          {
            sequence: 3,
            kind,
            commandId: job.id,
            reason: kind === 'command.rejected' ? 'stale turn' : undefined,
          },
        ]),
        456
      );
      expect(outbox.jobs.getJob(job.id)?.status).toBe(
        kind === 'command.resolved' ? 'completed' : 'dead'
      );
      expect(outbox.journal.active(sid)?.state).toEqual({ phase: 'busy', turnId: 'turn-live' });
      expect(outbox.exchange(frame(), 456)).toEqual({ ack: 3 });
    }
  );

  test('a resolved-but-dropped prompt is rejected rather than treated as accepted delivery', () => {
    const job = submit();
    idle();
    outbox.exchange(
      frame([
        {
          sequence: 2,
          kind: 'command.resolved',
          commandId: job.id,
          result: { drop: 'human stop requires user input' },
        },
      ]),
      456
    );
    expect(outbox.jobs.getJob(job.id)?.status).toBe('dead');
    expect(outbox.jobs.getJob(job.id)?.error).toContain('human stop requires user input');
    expect(outbox.withdraw(sid, from, job.id)).toMatchObject({ value: { withdrawn: false } });
  });

  test('a completion releases the next input but duplicate facts cannot consume it twice', () => {
    const first = submit();
    const second = submit();
    idle();
    const completed = frame([
      {
        sequence: 2,
        kind: 'command.resolved',
        commandId: first.id,
        result: { origin: { kind: 'plugin' } },
      },
    ]);
    const next = outbox.exchange(completed, 456, true).command;
    expect(next?.id).toBe(second.id);
    expect(outbox.exchange(completed, 456, true).command).toEqual(next);
    expect(outbox.jobs.getJob(first.id)?.status).toBe('completed');
  });

  test('unrelated command IDs and another session’s receipts cannot complete arbitrary jobs', () => {
    const foreign = outbox.jobs.enqueue({
      queue: `claude_desktop_mods:${sid}:foreign`,
      payload: { sessionId: sid, from, instanceId, ownerPid: 456, kind: 'foreign' },
    });
    outbox.jobs.dequeue(foreign.queue);
    const other = outbox.enqueue(otherSid, from, { kind: 'submit', text: 'other question' });
    outbox.exchange(start, 456);
    outbox.exchange(
      frame([
        { sequence: 2, kind: 'command.resolved', commandId: foreign.id },
        { sequence: 3, kind: 'command.resolved', commandId: other.id },
      ]),
      456
    );
    expect(outbox.jobs.getJob(foreign.id)?.status).toBe('processing');
    expect(outbox.jobs.getJob(other.id)?.status).toBe('pending');
  });

  test('ended sessions do not dispatch pending input or stop commands', () => {
    const input = submit();
    const stop = outbox.enqueue(sid, from, { kind: 'stop', turnId: 'old' });
    expect(
      outbox.exchange(frame([...start.events, { sequence: 2, kind: 'session.end' }]), 456, true)
    ).toEqual({ ack: 2 });
    expect(outbox.jobs.getJob(input.id)?.status).toBe('pending');
    expect(outbox.jobs.getJob(stop.id)?.status).toBe('pending');
  });

  test('a failed claim binding rolls back both the new journal ACK and the dequeue', () => {
    const job = submit();
    db.exec(
      "CREATE TRIGGER fail_binding BEFORE UPDATE ON job_queue WHEN json_extract(NEW.payload, '$.instanceId') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'claim failure'); END"
    );
    expect(() => idle()).toThrow('claim failure');
    expect(outbox.journal.active(sid)).toBeNull();
    expect(outbox.jobs.getJob(job.id)).toMatchObject({ status: 'pending', payload: { from } });
    expect(outbox.jobs.getJob(job.id)?.claimToken).toBeNull();
    db.exec('DROP TRIGGER fail_binding');
    expect(outbox.withdraw(sid, from, job.id)).toMatchObject({ value: { withdrawn: true } });
  });

  test('receipt settlement and next claim share the journal transaction', () => {
    const first = submit();
    const second = submit();
    idle();
    db.exec(
      `CREATE TRIGGER fail_binding BEFORE UPDATE ON job_queue WHEN NEW.id = '${second.id}' AND json_extract(NEW.payload, '$.instanceId') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'next claim failure'); END`
    );
    const receipt = frame([{ sequence: 2, kind: 'command.resolved', commandId: first.id }]);
    expect(() => outbox.exchange(receipt, 456, true)).toThrow('next claim failure');
    expect(outbox.journal.active(sid)?.sequence).toBe(1);
    expect(outbox.jobs.getJob(first.id)?.status).toBe('processing');
    expect(outbox.jobs.getJob(second.id)?.status).toBe('pending');
    db.exec('DROP TRIGGER fail_binding');
    expect(outbox.exchange(receipt, 456, true).command?.id).toBe(second.id);
  });

  test('the real private socket exchanges only committed exact-instance commands', async () => {
    const input = submit();
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
    const errors: unknown[] = [];
    const server = await createClaudeDesktopModsServer({
      parentDirectory: dir,
      registrationsDir: dir,
      liveSessions: async () => [{ sessionId: sid, pid: 456, owner: 'desktop', status: 'idle' }],
      persist: async (exchange, pid) => outbox.exchange(exchange, pid, true),
      onError: (e) => void errors.push(e),
    });
    const config = JSON.parse(await readFile(server.connectionFile, 'utf8'));
    const send = (exchange: Exchange) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          {
            socketPath: config.socketPath,
            method: 'POST',
            path: '/bridge/exchange',
            agent: false,
            headers: { authorization: `Bearer ${config.token}` },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
              body += chunk;
            });
            res.once('end', () => resolve({ status: res.statusCode!, body }));
          }
        );
        req.once('error', reject);
        req.end(JSON.stringify(exchange));
      });
    try {
      const response = await send(start);
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body).command).toEqual({
        id: input.id,
        instanceId,
        kind: 'submit',
        from,
        text: 'peer\n"question"',
      });
      expect(outbox.jobs.getJob(input.id)?.status).toBe('processing');
      expect(await send(start)).toEqual(response);
      const settled = await send(
        frame([
          {
            sequence: 2,
            kind: 'command.resolved',
            commandId: input.id,
            result: { origin: { kind: 'plugin' } },
          },
        ])
      );
      expect(JSON.parse(settled.body)).toEqual({ ack: 2 });
      expect(outbox.jobs.getJob(input.id)?.status).toBe('completed');
      expect(errors).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
