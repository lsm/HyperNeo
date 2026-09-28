import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration279 } from '../../../../src/storage/schema/m279-neo-consultations.ts';
import { runMigration280 } from '../../../../src/storage/schema/m280-neo-context-write-grants.ts';
import { runMigration282 } from '../../../../src/storage/schema/m282-neo-consultation-origins.ts';
import { runMigration285 } from '../../../../src/storage/schema/m285-neo-consultation-waiters.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NeoConsultationRepository } from '../../../../src/storage/repositories/neo-consultation-repository.ts';
import { NeoConsultationWaiterRepository } from '../../../../src/storage/repositories/neo-consultation-waiter-repository.ts';
import { CONSULTATION_TIMEOUT_MS } from '../../../../src/lib/neo/consultation-policy.ts';

const request = (id: string, concernId = 'club') => ({
  id,
  requestKey: id,
  concernId,
  originSessionId: 'root',
  originMessageId: `human:${id}`,
  sessionId: `holder:${concernId}`,
  question: `Question for ${id}`,
});

describe('NeoConsultationWaiterRepository', () => {
  let db: Database;
  let dir: string;
  let waiters: NeoConsultationWaiterRepository;
  let consultations: NeoConsultationRepository;
  let concerns: NeoRepository;
  let notices: number;
  const reopen = () => {
    db = new Database(join(dir, 'test.db'));
    db.exec('PRAGMA foreign_keys = ON');
    concerns = new NeoRepository(db);
    consultations = new NeoConsultationRepository(db, () => {});
    waiters = new NeoConsultationWaiterRepository(db, () => notices++);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'neo-waiters-'));
    notices = 0;
    reopen();
    createNeoTables(db);
    runMigration279(db);
    runMigration282(db);
    runMigration280(db);
    runMigration285(db);
    for (const id of ['club', 'family']) {
      concerns.saveConcern({ id, title: id, summary: 'Recorded', context: 'Original' }, 0);
      concerns.reserveBinding({ sessionId: `holder:${id}`, concernId: id, kind: 'concern' });
    }
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('persists immutable identities and returns the original receipt on conflicting retries', () => {
    const input = request('correction');
    const original = waiters.enqueue(input);
    expect(original).toMatchObject({ ...input, status: 'queued' });
    expect(
      waiters.enqueue({
        ...input,
        id: 'retry',
        originMessageId: 'later-callback',
        question: 'An unrelated question',
        sessionId: 'another-holder',
      })
    ).toEqual(original);
    expect(notices).toBe(1);
    expect(waiters.enqueue({ ...request('collision'), id: input.id })).toBeNull();
    db.close();
    reopen();
    expect(waiters.get(input.id)).toEqual(original);
    expect(waiters.find(input.originSessionId, input.requestKey)).toEqual(original);
    expect(waiters.find('another-root', input.requestKey)).toBeNull();
    expect(waiters.get('missing')).toBeNull();
  });

  test('admits FIFO without overlapping a busy holder and leaves other holders available', () => {
    consultations.reserve(request('active'));
    waiters.enqueue(request('z-first'));
    waiters.enqueue(request('a-second'));
    db.prepare('UPDATE neo_consultation_waiters SET created_at = 1').run();
    waiters.enqueue(request('family-read', 'family'));
    expect(waiters.queued('club').map(({ id }) => id)).toEqual(['z-first', 'a-second']);
    expect(waiters.admitNext('club')).toBeNull();
    expect(waiters.admitNext('family')).toMatchObject({
      ...request('family-read', 'family'),
      status: 'pending',
    });
    expect(waiters.admitNext('missing')).toBeNull();
    consultations.finish('active', 'reported', 'Status answer');
    expect(waiters.admitNext('club')).toMatchObject({ ...request('z-first'), status: 'pending' });
    db.close();
    reopen();
    expect(consultations.get('z-first')).toMatchObject({
      ...request('z-first'),
      status: 'pending',
    });
    expect(waiters.get('z-first')?.status).toBe('admitted');
    expect(waiters.admitNext('club')).toBeNull();
    expect(waiters.cancel('z-first')?.status).toBe('admitted');
    expect(consultations.get('z-first')?.status).toBe('pending');
    expect(waiters.queued('club').map(({ id }) => id)).toEqual(['a-second']);
    consultations.finish('z-first', 'failed', 'Stopped waiting');
    expect(waiters.admitNext('club')).toMatchObject({ ...request('a-second'), status: 'pending' });
    expect(waiters.queued()).toHaveLength(0);
    expect(
      db.prepare("SELECT COUNT(*) AS total FROM neo_consultations WHERE status = 'pending'").get()
    ).toEqual({ total: 2 });
    expect(consultations.reserve({ ...request('overlap'), concernId: 'club' })).toBeNull();
  });

  test('starts the original deadline and captures the current revision only at admission', () => {
    waiters.enqueue(request('correction'));
    const queuedAt = Date.now() - 2 * CONSULTATION_TIMEOUT_MS;
    db.prepare('UPDATE neo_consultation_waiters SET created_at = ?').run(queuedAt);
    expect(db.prepare('SELECT * FROM neo_context_write_grants').all()).toHaveLength(0);
    const current = concerns.saveConcern(
      { id: 'club', title: 'Club', summary: 'Changed', context: 'New human fact' },
      1
    )!;
    const beforeAdmission = Date.now();
    const admitted = waiters.admitNext('club')!;
    expect(admitted.createdAt).toBeGreaterThanOrEqual(beforeAdmission);
    expect(waiters.get('correction')?.createdAt).toBe(queuedAt);
    expect(consultations.expire('correction')?.status).toBe('pending');
    expect(db.prepare('SELECT * FROM neo_context_write_grants').all()).toEqual([
      { consultation_id: 'correction', context_revision: current.revision },
    ]);
    expect(
      concerns.saveConsultationContext(
        { id: 'club', title: 'Club', summary: 'Applied', context: 'Saved correction' },
        current.revision,
        admitted.id,
        admitted.sessionId
      )
    ).toMatchObject({ revision: 3, context: 'Saved correction' });
    expect(admitted.originMessageId).toBe('human:correction');
  });

  test('preserves cancellation tombstones across reopening without admitting cancelled asks', () => {
    const input = request('cancelled');
    waiters.enqueue(input);
    const cancelled = waiters.cancel(input.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(waiters.cancel(input.id)).toEqual(cancelled);
    expect(waiters.cancel('missing')).toBeNull();
    expect(notices).toBe(2);
    db.close();
    reopen();
    expect(waiters.enqueue({ ...input, id: 'retry' })).toEqual(cancelled);
    expect(waiters.queued()).toHaveLength(0);
    expect(waiters.admitNext('club')).toBeNull();
    expect(consultations.get(input.id)).toBeNull();
    expect(notices).toBe(2);
  });

  test('rolls back consultation and revision grant when waiter admission fails', () => {
    const queued = waiters.enqueue(request('correction'));
    notices = 0;
    db.exec(`CREATE TRIGGER reject_waiter_admission BEFORE UPDATE ON neo_consultation_waiters
      WHEN NEW.status = 'admitted' BEGIN SELECT RAISE(ABORT, 'test admission failure'); END`);
    expect(() => waiters.admitNext('club')).toThrow('test admission failure');
    expect(waiters.get('correction')).toEqual(queued);
    expect(consultations.get('correction')).toBeNull();
    expect(db.prepare('SELECT * FROM neo_context_write_grants').all()).toHaveLength(0);
    expect(notices).toBe(0);
    db.exec('DROP TRIGGER reject_waiter_admission');
    expect(waiters.admitNext('club')?.id).toBe('correction');
    expect(notices).toBe(1);
  });

  test('never adopts a different receipt for an already-used consultation request key', () => {
    const existing = consultations.reserve(request('original'));
    const queued = waiters.enqueue({ ...request('new'), requestKey: 'original' });
    waiters.enqueue(request('next'));
    notices = 0;
    expect(waiters.admitNext('club')).toBeNull();
    expect(waiters.get('new')).toEqual({ ...queued, status: 'cancelled' });
    expect(consultations.get('original')).toEqual(existing);
    expect(consultations.get('new')).toBeNull();
    expect(waiters.get('next')?.status).toBe('queued');
    expect(notices).toBe(1);
    consultations.finish('original', 'reported', 'Original answer');
    expect(waiters.admitNext('club')?.originMessageId).toBe('human:next');
  });

  test.each(['originMessageId', 'sessionId', 'question'] as const)(
    'rejects a matching ID whose existing %s belongs to a different input',
    (field) => {
      const input = request('correction');
      const existing = consultations.reserve({ ...input, [field]: 'another-input' });
      const queued = waiters.enqueue(input);
      notices = 0;
      expect(waiters.admitNext('club')).toBeNull();
      expect(waiters.get(input.id)).toEqual({ ...queued, status: 'cancelled' });
      expect(consultations.get(input.id)).toEqual(existing);
      expect(notices).toBe(1);
    }
  );

  test('skips consumed keys beyond the bounded read window and admits the next exact input', () => {
    for (let index = 0; index < 23; index++) {
      consultations.reserve(request(`consumed-${index}`));
      consultations.finish(`consumed-${index}`, 'reported', 'Existing answer');
      waiters.enqueue({ ...request(`poison-${index}`), requestKey: `consumed-${index}` });
    }
    waiters.enqueue(request('eligible'));
    notices = 0;
    expect(waiters.admitNext('club')).toMatchObject({
      ...request('eligible'),
      status: 'pending',
    });
    expect(waiters.queued()).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS total FROM neo_consultation_waiters WHERE status = 'cancelled'"
        )
        .get()
    ).toEqual({ total: 23 });
    expect(consultations.get('consumed-22')?.answer).toBe('Existing answer');
    expect(notices).toBe(1);
  });

  test('skips an ID collision without changing the other holder’s existing receipt', () => {
    const existing = consultations.reserve({
      ...request('collision', 'family'),
      originSessionId: 'another-root',
      requestKey: 'consumed-key',
    });
    waiters.enqueue(request('collision'));
    waiters.enqueue(request('eligible'));
    expect(waiters.admitNext('club')?.originMessageId).toBe('human:eligible');
    expect(waiters.get('collision')?.status).toBe('cancelled');
    expect(consultations.get('collision')).toEqual(existing);
    expect(waiters.admitNext('club')).toBeNull();
  });

  test('rolls back skipped conflicts when a later admission fails without publishing notices', () => {
    consultations.reserve(request('consumed'));
    consultations.finish('consumed', 'reported', 'Existing answer');
    const poison = waiters.enqueue({ ...request('poison'), requestKey: 'consumed' });
    const eligible = waiters.enqueue(request('eligible'));
    notices = 0;
    db.exec(`CREATE TRIGGER reject_waiter_admission BEFORE UPDATE ON neo_consultation_waiters
      WHEN NEW.status = 'admitted' BEGIN SELECT RAISE(ABORT, 'test admission failure'); END`);
    expect(() => waiters.admitNext('club')).toThrow('test admission failure');
    expect(waiters.get('poison')).toEqual(poison);
    expect(waiters.get('eligible')).toEqual(eligible);
    expect(consultations.get('eligible')).toBeNull();
    expect(db.prepare('SELECT * FROM neo_context_write_grants').all()).toHaveLength(1);
    expect(notices).toBe(0);
    db.exec('DROP TRIGGER reject_waiter_admission');
    expect(waiters.admitNext('club')?.originMessageId).toBe('human:eligible');
    expect(waiters.get('poison')?.status).toBe('cancelled');
    expect(notices).toBe(1);
  });

  test('bounds FIFO queue reads to twenty entries without dropping durable receipts', () => {
    consultations.reserve(request('busy'));
    for (let index = 0; index < 23; index++) waiters.enqueue(request(`queued-${index}`));
    waiters.enqueue(request('late-family', 'family'));
    expect(waiters.queued()).toHaveLength(20);
    expect(waiters.queued()[0]?.id).toBe('queued-0');
    expect(waiters.get('queued-22')?.originMessageId).toBe('human:queued-22');
    expect(waiters.queuedConcerns()).toEqual(['club', 'family']);
    expect(notices).toBe(24);
    expect(waiters.admitNext('club')).toBeNull();
    expect(waiters.admitNext('family')?.originMessageId).toBe('human:late-family');
    expect(waiters.queuedConcerns()).toEqual(['club']);
  });
});
