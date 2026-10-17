import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat';
import { runMigration388 } from '../../../../src/storage/schema/m388-claude-desktop-bridge-events';
import { ClaudeDesktopBridgeRepository } from '../../../../src/storage/repositories/claude-desktop-bridge-repository';
import { createClaudeDesktopModsServer } from '../../../../src/lib/drivers/claude-desktop-mods-server';
import { readFile } from 'node:fs/promises';

type Exchange = Parameters<ClaudeDesktopBridgeRepository['persist']>[0];
type Event = Exchange['events'][number];
const sessionId = '3b286924-739c-487d-82d2-c3e36fd5ed36';
const instanceId = `${sessionId}:1234:1`;
const start: Event = { sequence: 1, kind: 'session.start' };
const frame = (events: Event[] = [start], id = instanceId): Exchange => ({
  version: 1,
  sessionId,
  instanceId: id,
  events,
});

describe('ClaudeDesktopBridgeRepository', () => {
  let dir: string;
  let db: Database;
  let repository: ClaudeDesktopBridgeRepository;
  beforeEach(async () => {
    dir = await mkdtemp('/tmp/hn-store-');
    db = new Database(join(dir, 'journal.db'));
    db.exec('PRAGMA foreign_keys = ON');
    runMigration388(db);
    repository = new ClaudeDesktopBridgeRepository(db);
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  test('migration is idempotent without erasing existing checkpoints or events', () => {
    repository.persist(frame(), 456);
    runMigration388(db);
    expect(repository.events(sessionId, instanceId)).toEqual([start]);
    expect(repository.active(sessionId)).toEqual({
      instanceId,
      ownerPid: 456,
      sequence: 1,
      retired: false,
      state: { phase: 'unknown', turnId: null },
    });
    expect(() =>
      db
        .prepare('INSERT INTO claude_desktop_bridge_instances VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(sessionId, 'other', 456, 0, 0, '{}', 0)
    ).toThrow();
  });

  test('persists a full contiguous batch and recovers ACK and state after reopening the database', () => {
    const events: Event[] = [start, { sequence: 2, kind: 'turn.start', turnId: 'turn-a' }];
    expect(repository.persist(frame(events), 456)).toEqual({ ack: 2 });
    db.close();
    db = new Database(join(dir, 'journal.db'));
    repository = new ClaudeDesktopBridgeRepository(db);
    expect(repository.events(sessionId, instanceId)).toEqual(events);
    expect(repository.active(sessionId)?.state).toEqual({ phase: 'busy', turnId: 'turn-a' });
    expect(repository.persist(frame([]), 456)).toEqual({ ack: 2 });
    expect(repository.persist(frame(events), 456)).toEqual({ ack: 2 });
    expect(repository.events(sessionId, instanceId)).toHaveLength(2);
  });

  test('accepts semantically identical replays with differently ordered nested result keys', () => {
    const event: Event = {
      sequence: 2,
      kind: 'command.resolved',
      commandId: 'command-a',
      result: { text: 'peer input', origin: { kind: 'plugin', name: 'hyperneo-desktop-bridge' } },
    };
    repository.persist(frame([start, event]), 456);
    const replay: Event = {
      commandId: 'command-a',
      kind: 'command.resolved',
      sequence: 2,
      result: { origin: { name: 'hyperneo-desktop-bridge', kind: 'plugin' }, text: 'peer input' },
    };
    expect(
      repository.persist(
        frame([replay, { sequence: 3, kind: 'session.end', reason: 'other' }]),
        456
      )
    ).toEqual({ ack: 3 });
    expect(repository.events(sessionId, instanceId)).toHaveLength(3);
  });

  test('keeps command API receipts distinct from observed turn completion', () => {
    repository.persist(
      frame([
        start,
        { sequence: 2, kind: 'turn.start', turnId: 'turn-a' },
        { sequence: 3, kind: 'command.resolved', commandId: 'stop-a' },
      ]),
      456
    );
    expect(repository.active(sessionId)?.state).toEqual({ phase: 'busy', turnId: 'turn-a' });
    repository.persist(
      frame([
        {
          sequence: 4,
          kind: 'turn.complete',
          turnId: 'turn-a',
          reason: 'aborted',
          isAborted: true,
        },
      ]),
      456
    );
    expect(repository.active(sessionId)?.state).toEqual({ phase: 'idle', turnId: null });
  });

  test('an old turn completion cannot clear a newer live turn', () => {
    repository.persist(
      frame([
        start,
        { sequence: 2, kind: 'turn.start', turnId: 'turn-a' },
        { sequence: 3, kind: 'turn.start', turnId: 'turn-b' },
        { sequence: 4, kind: 'turn.complete', turnId: 'turn-a', reason: 'answer' },
      ]),
      456
    );
    expect(repository.active(sessionId)?.state).toEqual({ phase: 'busy', turnId: 'turn-b' });
    expect(repository.events(sessionId, instanceId)).toHaveLength(4);
  });

  test('an observed completion establishes idle from unknown, but does not reopen an ended session', () => {
    repository.persist(
      frame([
        start,
        { sequence: 2, kind: 'turn.complete', turnId: 'pre-plugin-turn', reason: 'answer' },
      ]),
      456
    );
    expect(repository.active(sessionId)?.state.phase).toBe('idle');
    repository.persist(
      frame([
        { sequence: 3, kind: 'session.end', reason: 'clear' },
        { sequence: 4, kind: 'turn.complete', turnId: 'pre-plugin-turn', reason: 'answer' },
      ]),
      456
    );
    expect(repository.active(sessionId)?.state).toEqual({ phase: 'ended', turnId: null });
  });

  test.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, 457])(
    'rejects changed or invalid owner PID %s without writes',
    (pid) => {
      repository.persist(frame(), 456);
      expect(() =>
        repository.persist(frame([{ sequence: 2, kind: 'turn.start', turnId: 'turn-a' }]), pid)
      ).toThrow('instance or owner changed');
      expect(repository.events(sessionId, instanceId)).toEqual([start]);
      expect(repository.active(sessionId)?.sequence).toBe(1);
    }
  );

  test.each([
    { events: [] },
    { events: [{ sequence: 2, kind: 'session.start' }] },
    { events: [{ sequence: 1, kind: 'turn.start', turnId: 'turn-a' }] },
  ] as { events: Event[] }[])('a new instance requires its own initial event: %j', ({ events }) => {
    expect(() => repository.persist(frame(events), 456)).toThrow('requires session.start');
    expect(repository.active(sessionId)).toBeNull();
    expect(repository.events(sessionId, instanceId)).toEqual([]);
  });

  test('rejects a conflicting duplicate before committing any following event', () => {
    repository.persist(frame(), 456);
    expect(() =>
      repository.persist(
        frame([
          { sequence: 1, kind: 'session.start', reason: 'tampered' },
          { sequence: 2, kind: 'session.end' },
        ]),
        456
      )
    ).toThrow('Conflicting');
    expect(repository.active(sessionId)?.sequence).toBe(1);
    expect(repository.events(sessionId, instanceId)).toEqual([start]);
  });

  test('rejects a gap without committing the valid prefix', () => {
    repository.persist(frame(), 456);
    expect(() =>
      repository.persist(
        frame([
          { sequence: 2, kind: 'turn.start', turnId: 'turn-a' },
          { sequence: 4, kind: 'session.end' },
        ]),
        456
      )
    ).toThrow('sequence gap');
    expect(repository.active(sessionId)?.state).toEqual({ phase: 'unknown', turnId: null });
    expect(repository.events(sessionId, instanceId)).toEqual([start]);
  });

  test('retired instances remain fenced across daemon restarts and preserve their history', () => {
    repository.persist(
      frame([start, { sequence: 2, kind: 'turn.start', turnId: 'old-turn' }]),
      456
    );
    const nextInstance = `${sessionId}:2345:1`;
    repository.persist(frame([start], nextInstance), 457);
    db.close();
    db = new Database(join(dir, 'journal.db'));
    repository = new ClaudeDesktopBridgeRepository(db);
    expect(() =>
      repository.persist(frame([{ sequence: 3, kind: 'turn.complete', turnId: 'old-turn' }]), 456)
    ).toThrow('instance or owner changed');
    expect(repository.active(sessionId)?.instanceId).toBe(nextInstance);
    expect(repository.active(sessionId)?.state.phase).toBe('unknown');
    expect(repository.events(sessionId, instanceId)).toHaveLength(2);
  });

  test('a failed new-instance transaction does not retire the previous active instance', () => {
    repository.persist(frame(), 456);
    db.exec(
      `CREATE TRIGGER reject_bridge_event BEFORE INSERT ON claude_desktop_bridge_events WHEN NEW.instance_id != '${instanceId}' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`
    );
    const nextInstance = `${sessionId}:2345:1`;
    expect(() => repository.persist(frame([start], nextInstance), 457)).toThrow('injected failure');
    expect(repository.active(sessionId)?.instanceId).toBe(instanceId);
    expect(repository.events(sessionId, nextInstance)).toEqual([]);
    expect(repository.persist(frame([]), 456)).toEqual({ ack: 1 });
  });

  test('a mid-batch SQLite failure rolls back the entire journal and checkpoint', () => {
    repository.persist(frame(), 456);
    db.exec(
      "CREATE TRIGGER reject_bridge_event BEFORE INSERT ON claude_desktop_bridge_events WHEN NEW.sequence = 3 BEGIN SELECT RAISE(ABORT, 'injected failure'); END"
    );
    const events: Event[] = [
      { sequence: 2, kind: 'turn.start', turnId: 'turn-a' },
      { sequence: 3, kind: 'turn.complete', turnId: 'turn-a' },
    ];
    expect(() => repository.persist(frame(events), 456)).toThrow('injected failure');
    expect(repository.active(sessionId)?.sequence).toBe(1);
    expect(repository.events(sessionId, instanceId)).toEqual([start]);
    db.exec('DROP TRIGGER reject_bridge_event');
    expect(repository.persist(frame(events), 456)).toEqual({ ack: 3 });
  });

  test('independent SQLite connections cannot append conflicting events under the same sequence', () => {
    repository.persist(frame(), 456);
    const otherDb = new Database(join(dir, 'journal.db'));
    try {
      const other = new ClaudeDesktopBridgeRepository(otherDb);
      repository.persist(frame([{ sequence: 2, kind: 'turn.start', turnId: 'turn-a' }]), 456);
      expect(() =>
        other.persist(frame([{ sequence: 2, kind: 'turn.start', turnId: 'turn-b' }]), 456)
      ).toThrow('Conflicting');
      expect(other.active(sessionId)?.state.turnId).toBe('turn-a');
    } finally {
      otherDb.close();
    }
  });

  test('foreign keys forbid an event without an instance checkpoint', () => {
    expect(() =>
      db
        .prepare('INSERT INTO claude_desktop_bridge_events VALUES (?, ?, ?, ?, ?)')
        .run(sessionId, instanceId, 1, '{}', 0)
    ).toThrow();
  });

  test('the real socket ACK is backed by committed journal rows and survives a lost response retry', async () => {
    await writeFile(
      join(dir, '456.json'),
      JSON.stringify({
        sessionId,
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
      liveSessions: async () => [{ sessionId, pid: 456, owner: 'desktop', status: 'idle' }],
      persist: async (exchange, pid) => repository.persist(exchange, pid),
      onError: (error) => void errors.push(error),
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
      expect(await send(frame())).toEqual({ status: 200, body: '{"ack":1}' });
      expect(await send(frame())).toEqual({ status: 200, body: '{"ack":1}' });
      expect(repository.events(sessionId, instanceId)).toEqual([start]);
      db.exec(
        "CREATE TRIGGER reject_bridge_event BEFORE INSERT ON claude_desktop_bridge_events BEGIN SELECT RAISE(ABORT, 'disk failure'); END"
      );
      expect(await send(frame([{ sequence: 2, kind: 'session.end' }]))).toEqual({
        status: 500,
        body: '',
      });
      expect(repository.active(sessionId)?.sequence).toBe(1);
      expect(errors).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});
