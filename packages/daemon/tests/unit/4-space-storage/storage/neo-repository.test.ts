import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';

const concern = { id: 'launch', title: 'Launch', summary: 'Prepare launch', context: 'Friday' };

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
    repo.saveProject({ ...concern, id: 'project:x', title: 'legacy-1' }, 0);
    expect(repo.resolveProjectRef('legacy-1')).toBe('legacy-1');
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

  test('reserves one root and separate workers', () => {
    repo.saveProject(concern, 0);
    const root = { sessionId: 'root', projectId: null, kind: 'neo' as const };
    expect(repo.reserveBinding(root)).toBe(true);
    expect(repo.reserveBinding({ ...root, sessionId: 'another-root' })).toBe(false);
    for (const sessionId of ['worker-1', 'worker-2']) {
      expect(repo.reserveBinding({ sessionId, projectId: concern.id, kind: 'worker' })).toBe(true);
    }
    expect(repo.reserveBinding({ sessionId: 'root', projectId: concern.id, kind: 'worker' })).toBe(
      false
    );
    expect(repo.getBindingBySession('root')).toEqual(root);
    expect(repo.defaultBinding()).toEqual(root);
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
      repo.reserveBinding({ sessionId: 'invalid', kind: 'worker', projectId: 'missing' })
    ).toThrow();
    expect(repo.getBindingBySession('invalid')).toBeNull();
  });

  test('persists across database reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neo-repository-'));
    const path = join(directory, 'neo.db');
    const first = new Database(path);
    try {
      createNeoTables(first);
      const initial = new NeoRepository(first);
      initial.saveProject(concern, 0);
      initial.reserveBinding({ sessionId: 'root', projectId: null, kind: 'neo' });
    } finally {
      first.close();
    }
    const reopened = new Database(path);
    try {
      createNeoTables(reopened);
      const restored = new NeoRepository(reopened);
      expect(restored.getProject(concern.id)).toMatchObject({ ...concern, revision: 1 });
      expect(restored.defaultBinding()?.sessionId).toBe('root');
    } finally {
      reopened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
