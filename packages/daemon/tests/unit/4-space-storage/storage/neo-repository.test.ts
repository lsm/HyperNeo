import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';

const concern = { id: 'launch', title: 'Launch', summary: 'Prepare launch', context: 'Friday' };
const proposal = {
  id: 'work-1',
  requestKey: 'request-1',
  concernId: 'launch',
  originSessionId: 'concern-session',
  title: 'Check readiness',
  instruction: 'Review the release checklist',
};

describe('NeoRepository', () => {
  let db: Database;
  let repo: NeoRepository;
  let notify: ReturnType<typeof mock>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    createNeoTables(db);
    notify = mock(() => {});
    repo = new NeoRepository(db, notify);
  });

  afterEach(() => db.close());

  test('creates concerns once and rejects stale changes without losing context', () => {
    expect(repo.listConcerns()).toEqual([]);
    const saved = repo.saveConcern(concern, 0);
    expect(saved).toMatchObject({ ...concern, revision: 1 });
    expect(repo.saveConcern({ ...concern, context: 'Duplicate' }, 0)).toBeNull();
    const next = repo.saveConcern({ ...concern, context: 'Monday' }, 1);
    expect(next).toMatchObject({ context: 'Monday', revision: 2, createdAt: saved!.createdAt });
    expect(repo.saveConcern({ ...concern, context: 'Stale Friday' }, 1)).toBeNull();
    expect(repo.getConcern(concern.id)).toEqual(next);
    expect(repo.listConcerns()).toEqual([next!]);
    expect(repo.getConcern('missing')).toBeNull();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  test('reserves one root and one coordinator per concern with separate workers', () => {
    repo.saveConcern(concern, 0);
    const root = { sessionId: 'root', concernId: null, kind: 'neo' as const };
    const coordinator = {
      sessionId: 'concern-session',
      concernId: concern.id,
      kind: 'concern' as const,
    };
    expect(repo.reserveBinding(root)).toBe(true);
    expect(repo.reserveBinding({ ...root, sessionId: 'another-root' })).toBe(false);
    expect(repo.reserveBinding(coordinator)).toBe(true);
    expect(repo.reserveBinding({ ...coordinator, sessionId: 'another-coordinator' })).toBe(false);
    for (const sessionId of ['worker-1', 'worker-2']) {
      expect(repo.reserveBinding({ sessionId, concernId: concern.id, kind: 'worker' })).toBe(true);
    }
    expect(repo.reserveBinding({ sessionId: 'root', concernId: concern.id, kind: 'worker' })).toBe(
      false
    );
    expect(repo.getBindingBySession('root')).toEqual(root);
    expect(repo.getBindingForConcern(null)).toEqual(root);
    expect(repo.getBindingForConcern(concern.id)).toEqual(coordinator);
    expect(repo.getBindingBySession('unknown')).toBeNull();
  });

  test('enforces coordinator kind and existing concern references', () => {
    expect(() =>
      repo.reserveBinding({ sessionId: 'invalid', kind: 'concern', concernId: null })
    ).toThrow();
    expect(() =>
      repo.reserveBinding({ sessionId: 'invalid', kind: 'worker', concernId: 'missing' })
    ).toThrow();
    expect(repo.getBindingBySession('invalid')).toBeNull();
  });

  test('proposes work idempotently by request key and scopes listings', () => {
    repo.saveConcern(concern, 0);
    const work = repo.proposeWork(proposal);
    expect(work).toMatchObject({ ...proposal, status: 'proposed', sessionId: null, report: null });
    expect(repo.proposeWork({ ...proposal, id: 'retry', instruction: 'Changed' })).toEqual(work);
    const rootWork = repo.proposeWork({
      ...proposal,
      id: 'root-work',
      requestKey: 'root-request',
      concernId: null,
      originSessionId: 'root',
    });
    expect(repo.listWork(concern.id)).toEqual([work]);
    expect(repo.listWork(null)).toEqual([rootWork]);
    expect(repo.listWork()).toHaveLength(2);
    expect(repo.getWork(work.id)).toEqual(work);
    expect(repo.getWork('missing')).toBeNull();
    expect(notify).toHaveBeenCalledTimes(3);
  });

  test('compares status, session, and report before applying a work transition', () => {
    repo.saveConcern(concern, 0);
    const work = repo.proposeWork(proposal);
    const queued = repo.transitionWork(work.id, work, { status: 'queued', sessionId: 'worker' });
    expect(queued).toMatchObject({ status: 'queued', sessionId: 'worker', report: null });
    expect(repo.transitionWork(work.id, work, { status: 'cancelled' })).toBeNull();
    expect(
      repo.transitionWork(work.id, { ...queued!, sessionId: 'stale' }, { status: 'failed' })
    ).toBeNull();
    expect(repo.findWorkBySession('worker')).toEqual(queued);
    const reported = repo.transitionWork(work.id, queued!, {
      status: 'reported',
      report: 'Checklist reviewed',
    });
    expect(reported).toMatchObject({
      status: 'reported',
      sessionId: 'worker',
      report: 'Checklist reviewed',
    });
    expect(
      repo.transitionWork(work.id, { ...reported!, report: 'Stale' }, { status: 'failed' })
    ).toBeNull();
    expect(repo.getWork(work.id)).toEqual(reported);
    expect(repo.findWorkBySession('missing')).toBeNull();
    expect(notify).toHaveBeenCalledTimes(4);
  });

  test('preserves context and delegation provenance after an execution session is deleted', () => {
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
    db.exec("INSERT INTO sessions VALUES ('worker')");
    repo.saveConcern(concern, 0);
    const work = repo.proposeWork(proposal);
    repo.reserveBinding({ sessionId: 'worker', concernId: concern.id, kind: 'worker' });
    repo.transitionWork(work.id, work, { status: 'queued', sessionId: 'worker' });
    db.exec("DELETE FROM sessions WHERE id = 'worker'");
    expect(repo.getConcern(concern.id)).toMatchObject(concern);
    expect(repo.getBindingBySession('worker')).toMatchObject({ concernId: concern.id });
    expect(repo.findWorkBySession('worker')).toMatchObject({
      originSessionId: 'concern-session',
      status: 'queued',
    });
  });

  test('links repeated delegations to one reusable execution session', () => {
    repo.saveConcern(concern, 0);
    const first = repo.proposeWork(proposal);
    repo.transitionWork(first.id, first, { status: 'reported', sessionId: 'existing-session' });
    const second = repo.proposeWork({ ...proposal, id: 'work-2', requestKey: 'request-2' });
    const queued = repo.transitionWork(second.id, second, {
      status: 'queued',
      sessionId: 'existing-session',
    });
    expect(repo.findWorkBySession('existing-session')).toEqual(queued);
    expect(repo.getWork(first.id)).toMatchObject({
      status: 'reported',
      sessionId: 'existing-session',
    });
    expect(repo.listWork(concern.id)).toHaveLength(2);
  });

  test('persists across database reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neo-repository-'));
    const path = join(directory, 'neo.db');
    const first = new Database(path);
    try {
      createNeoTables(first);
      const initial = new NeoRepository(first);
      initial.saveConcern(concern, 0);
      initial.reserveBinding({ sessionId: 'root', concernId: null, kind: 'neo' });
      initial.proposeWork(proposal);
    } finally {
      first.close();
    }
    const reopened = new Database(path);
    try {
      createNeoTables(reopened);
      const restored = new NeoRepository(reopened);
      expect(restored.getConcern(concern.id)).toMatchObject({ ...concern, revision: 1 });
      expect(restored.getBindingForConcern(null)?.sessionId).toBe('root');
      expect(restored.getWork(proposal.id)).toMatchObject(proposal);
    } finally {
      reopened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
