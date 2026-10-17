import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration283 } from '../../../../src/storage/schema/m283-neo-work-origins.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';

const concern = { id: 'launch', title: 'Launch', summary: 'Prepare launch', context: 'Friday' };
const proposal = {
  id: 'work-1',
  requestKey: 'request-1',
  projectId: 'launch',
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
    runMigration283(db);
    notify = mock(() => {});
    repo = new NeoRepository(db, notify);
  });

  afterEach(() => db.close());

  test('resolves a project from its bare id, prefixed id or title', () => {
    const daemon = { ...concern, id: 'project:4ce2', title: 'HyperNeo Daemon' };
    repo.saveProject(daemon, 0);
    repo.saveProject({ ...concern, id: 'legacy-1', title: 'Legacy' }, 0);

    expect(repo.resolveProjectRef('4ce2')).toBe('project:4ce2');
    expect(repo.resolveProjectRef('project:4ce2')).toBe('project:4ce2');
    expect(repo.resolveProjectRef(' hyperneo daemon ')).toBe('project:4ce2');
    expect(repo.resolveProjectRef('legacy-1')).toBe('legacy-1');
    expect(repo.resolveProjectRef('project:legacy-1')).toBe('legacy-1');
    expect(repo.resolveProjectRef('missing')).toBeNull();
  });

  test('creates projects once and rejects stale changes without losing context', () => {
    expect(repo.listProjects()).toEqual([]);
    const saved = repo.saveProject(concern, 0);
    expect(saved).toMatchObject({ ...concern, revision: 1 });
    expect(repo.saveProject({ ...concern, context: 'Duplicate' }, 0)).toBeNull();
    const next = repo.saveProject({ ...concern, context: 'Monday' }, 1);
    expect(next).toMatchObject({ context: 'Monday', revision: 2, createdAt: saved!.createdAt });
    expect(repo.saveProject({ ...concern, context: 'Stale Friday' }, 1)).toBeNull();
    expect(repo.getProject(concern.id)).toEqual(next);
    expect(repo.listProjects()).toEqual([next!]);
    expect(repo.getProject('missing')).toBeNull();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  test('reserves one root and one coordinator per concern with separate workers', () => {
    repo.saveProject(concern, 0);
    const root = { sessionId: 'root', projectId: null, kind: 'neo' as const };
    const coordinator = {
      sessionId: 'concern-session',
      projectId: concern.id,
      kind: 'project' as const,
    };
    expect(repo.reserveBinding(root)).toBe(true);
    expect(repo.reserveBinding({ ...root, sessionId: 'another-root' })).toBe(false);
    expect(repo.reserveBinding(coordinator)).toBe(true);
    expect(repo.reserveBinding({ ...coordinator, sessionId: 'another-coordinator' })).toBe(false);
    for (const sessionId of ['worker-1', 'worker-2']) {
      expect(repo.reserveBinding({ sessionId, projectId: concern.id, kind: 'worker' })).toBe(true);
    }
    expect(repo.reserveBinding({ sessionId: 'root', projectId: concern.id, kind: 'worker' })).toBe(
      false
    );
    expect(repo.getBindingBySession('root')).toEqual(root);
    expect(repo.getBindingForProject(null)).toEqual(root);
    expect(repo.getBindingForProject(concern.id)).toEqual(coordinator);
    expect(repo.getBindingBySession('unknown')).toBeNull();
  });

  test('keeps the conversation id once taken from the default Neo session', () => {
    expect(repo.conversationId()).toBeNull();
    repo.reserveBinding({ sessionId: 'neo:conv-1', projectId: null, kind: 'neo' });
    expect(repo.defaultBinding()?.sessionId).toBe('neo:conv-1');
    expect(repo.conversationId()).toBe('conv-1');
    db.exec("DELETE FROM neo_session_bindings WHERE session_id = 'neo:conv-1'");
    expect(repo.defaultBinding()).toBeNull();
    expect(repo.conversationId()).toBe('conv-1');
  });

  test('enforces coordinator kind and existing concern references', () => {
    expect(() =>
      repo.reserveBinding({ sessionId: 'invalid', kind: 'project', projectId: null })
    ).toThrow();
    expect(() =>
      repo.reserveBinding({ sessionId: 'invalid', kind: 'worker', projectId: 'missing' })
    ).toThrow();
    expect(repo.getBindingBySession('invalid')).toBeNull();
  });

  test('proposes work idempotently by request key and scopes listings', () => {
    repo.saveProject(concern, 0);
    const work = repo.proposeWork(proposal);
    expect(work).toMatchObject({ ...proposal, status: 'proposed', sessionId: null, report: null });
    expect(repo.proposeWork({ ...proposal, id: 'retry', instruction: 'Changed' })).toEqual(work);
    const rootWork = repo.proposeWork({
      ...proposal,
      id: 'root-work',
      requestKey: 'root-request',
      projectId: null,
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
    repo.saveProject(concern, 0);
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
    repo.saveProject(concern, 0);
    const work = repo.proposeWork(proposal);
    repo.reserveBinding({ sessionId: 'worker', projectId: concern.id, kind: 'worker' });
    repo.transitionWork(work.id, work, { status: 'queued', sessionId: 'worker' });
    db.exec("DELETE FROM sessions WHERE id = 'worker'");
    expect(repo.getProject(concern.id)).toMatchObject(concern);
    expect(repo.getBindingBySession('worker')).toMatchObject({ projectId: concern.id });
    expect(repo.findWorkBySession('worker')).toMatchObject({
      originSessionId: 'concern-session',
      status: 'queued',
    });
  });

  test('links repeated delegations to one reusable execution session', () => {
    repo.saveProject(concern, 0);
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
      runMigration283(first);
      const initial = new NeoRepository(first);
      initial.saveProject(concern, 0);
      initial.reserveBinding({ sessionId: 'root', projectId: null, kind: 'neo' });
      initial.proposeWork({ ...proposal, originMessageId: 'persisted-ask' });
    } finally {
      first.close();
    }
    const reopened = new Database(path);
    try {
      createNeoTables(reopened);
      runMigration283(reopened);
      const restored = new NeoRepository(reopened);
      expect(restored.getProject(concern.id)).toMatchObject({ ...concern, revision: 1 });
      expect(restored.getBindingForProject(null)?.sessionId).toBe('root');
      expect(restored.getWork(proposal.id)).toMatchObject({
        ...proposal,
        originMessageId: 'persisted-ask',
      });
    } finally {
      reopened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
