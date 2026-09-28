import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration279 } from '../../../../src/storage/schema/m279-neo-consultations.ts';
import { runMigration282 } from '../../../../src/storage/schema/m282-neo-consultation-origins.ts';
import { runMigration280 } from '../../../../src/storage/schema/m280-neo-context-write-grants.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NeoConsultationRepository } from '../../../../src/storage/repositories/neo-consultation-repository.ts';
import { CONSULTATION_TIMEOUT_MS } from '../../../../src/lib/neo/consultation-policy.ts';

const concern = { id: 'club', title: 'Club', summary: 'Sunday', context: 'Six people' };
const request = {
  id: 'check',
  requestKey: 'check',
  concernId: 'club',
  originSessionId: 'root',
  sessionId: 'holder',
  question: 'Next?',
};

describe('Neo request-bound context storage', () => {
  let db: Database;
  let repo: NeoRepository;
  let consultations: NeoConsultationRepository;
  let notices: number;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'neo-write-grant-'));
    db = new Database(join(dir, 'test.db'));
    db.exec('PRAGMA foreign_keys = ON');
    createNeoTables(db);
    runMigration279(db);
    runMigration282(db);
    notices = 0;
    repo = new NeoRepository(db, () => {
      notices++;
    });
    consultations = new NeoConsultationRepository(db, () => {});
    repo.saveConcern(concern, 0);
    repo.reserveBinding({ sessionId: 'holder', concernId: 'club', kind: 'concern' });
    runMigration280(db);
    consultations.reserve(request);
    notices = 0;
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('advances only its own grant with successful writes and rejects stale retries', () => {
    const first = { ...concern, context: 'Eight people' };
    expect(repo.saveConsultationContext(first, 1, 'check', 'holder')).toMatchObject({
      revision: 2,
    });
    expect(repo.saveConsultationContext(first, 1, 'check', 'holder')).toBeNull();
    expect(
      repo.saveConsultationContext({ ...first, summary: 'Eight on Sunday' }, 2, 'check', 'holder')
    ).toMatchObject({ revision: 3, context: first.context });
    expect(notices).toBe(2);
    expect(db.prepare('SELECT context_revision FROM neo_context_write_grants').get()).toEqual({
      context_revision: 3,
    });
  });

  test('a fresh revision read and duplicate reservation cannot revive a stale request', () => {
    const corrected = repo.saveConcern({ ...concern, context: 'Eight people at my home' }, 1)!;
    const attempt = { ...concern, context: 'Six people at a library' };
    expect(consultations.reserve({ ...request, id: 'retry' })?.id).toBe('check');
    for (const revision of [1, corrected.revision]) {
      expect(repo.saveConsultationContext(attempt, revision, 'check', 'holder')).toBeNull();
    }
    expect(repo.getConcern('club')).toEqual(corrected);
    expect(notices).toBe(1);
    consultations.finish('check', 'failed', 'Superseded');
    consultations.reserve({ ...request, id: 'new', requestKey: 'new' });
    expect(
      repo.saveConsultationContext({ ...concern, context: corrected.context }, 2, 'new', 'holder')
    ).toMatchObject({ revision: 3, context: corrected.context });
  });

  test.each(['reported', 'failed', 'expired'])(
    'rejects %s requests without changing context or grant',
    (status) => {
      if (status === 'expired')
        db.prepare('UPDATE neo_consultations SET created_at = ?').run(
          Date.now() - CONSULTATION_TIMEOUT_MS
        );
      else consultations.finish('check', status as 'reported' | 'failed', 'Settled');
      const before = repo.getConcern('club');
      expect(
        repo.saveConsultationContext({ ...concern, context: 'Overwrite' }, 1, 'check', 'holder')
      ).toBeNull();
      expect(repo.getConcern('club')).toEqual(before);
      expect(notices).toBe(0);
      expect(db.prepare('SELECT context_revision FROM neo_context_write_grants').get()).toEqual({
        context_revision: 1,
      });
    }
  );

  test('rejects wrong holders, missing receipts, other concerns and worker bindings', () => {
    repo.saveConcern({ ...concern, id: 'other' }, 0);
    for (const [id, session] of [
      ['check', 'impostor'],
      ['missing', 'holder'],
    ]) {
      expect(repo.saveConsultationContext(concern, 1, id, session)).toBeNull();
    }
    expect(
      repo.saveConsultationContext({ ...concern, id: 'other' }, 1, 'check', 'holder')
    ).toBeNull();
    db.prepare("UPDATE neo_session_bindings SET kind = 'worker' WHERE session_id = 'holder'").run();
    expect(repo.saveConsultationContext(concern, 1, 'check', 'holder')).toBeNull();
    expect(repo.getConcern('club')?.revision).toBe(1);
  });

  test('rolls back the context update if grant advancement fails and emits no notification', () => {
    db.exec(`CREATE TRIGGER reject_grant_update BEFORE UPDATE ON neo_context_write_grants
      BEGIN SELECT RAISE(ABORT, 'test grant failure'); END`);
    const before = repo.getConcern('club');
    expect(() =>
      repo.saveConsultationContext({ ...concern, context: 'Lost update' }, 1, 'check', 'holder')
    ).toThrow('test grant failure');
    expect(repo.getConcern('club')).toEqual(before);
    expect(notices).toBe(0);
    expect(db.prepare('SELECT context_revision FROM neo_context_write_grants').get()).toEqual({
      context_revision: 1,
    });
  });

  test('cannot create a new consultation if its revision capture fails', () => {
    consultations.finish('check', 'reported', 'Done');
    db.exec(`CREATE TRIGGER reject_grant_insert BEFORE INSERT ON neo_context_write_grants
      BEGIN SELECT RAISE(ABORT, 'test capture failure'); END`);
    expect(() => consultations.reserve({ ...request, id: 'new', requestKey: 'new' })).toThrow(
      'test capture failure'
    );
    expect(consultations.get('new')).toBeNull();
    expect(repo.getConcern('club')?.revision).toBe(1);
    expect(notices).toBe(0);
  });

  test('preserves the grant across reopening and does not recapture a newer human revision', () => {
    repo.saveConcern({ ...concern, context: 'New human correction' }, 1);
    db.close();
    db = new Database(join(dir, 'test.db'));
    repo = new NeoRepository(db);
    runMigration280(db);
    expect(repo.saveConsultationContext(concern, 2, 'check', 'holder')).toBeNull();
    expect(repo.getConcern('club')?.context).toBe('New human correction');
  });

  test('migration leaves legacy pending requests ungranted without altering their state', () => {
    db.exec('DROP TRIGGER neo_consultation_capture_context_revision');
    consultations.finish('check', 'reported', 'Done');
    consultations.reserve({ ...request, id: 'legacy', requestKey: 'legacy' });
    const before = consultations.get('legacy');
    runMigration280(db);
    runMigration280(db);
    expect(consultations.get('legacy')).toEqual(before);
    expect(repo.saveConsultationContext(concern, 1, 'legacy', 'holder')).toBeNull();
    expect(repo.getConcern('club')?.context).toBe(concern.context);
  });
});
