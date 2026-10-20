import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { runMigration387 } from '../../../../src/storage/schema/m387-neo-ask-todo-tables.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration361 } from '../../../../src/storage/schema/m361-neo-project-avatars.ts';
import { runMigration370 } from '../../../../src/storage/schema/m370-neo-project-merges.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import {
  createNeoProjectMergePipeline,
  requireNeoMergeCurrent,
  requireNeoMergeTree,
  requireNeoMergeIdentity,
  type NeoProjectMergeInput,
  type NeoProjectMergeState,
} from '../../../../src/lib/neo/project-merge.ts';
import type { NeoProject } from '@hyperneo/shared/types/neo-context';

const identity = `git:${'a'.repeat(40)}`;
const other = `git:${'b'.repeat(40)}`;
const project = (id: string): NeoProject => ({
  id,
  title: id,
  summary: id,
  context: id,
  revision: 1,
  parentId: null,
  epicUrl: null,
  createdAt: 1,
  updatedAt: 1,
});
const source = project('source');
const target = project('target');
const input: NeoProjectMergeInput = {
  sourceId: source.id,
  targetId: target.id,
  sourceRevision: 1,
  targetRevision: 1,
  sourceIdentities: [identity],
  targetIdentities: [identity],
};
const state: NeoProjectMergeState = {
  projects: [source, target],
  identities: {},
  retired: [],
};
const plan = { source, target };

describe('Neo merge pure gates', () => {
  test('rejects stale, missing and retired projects', () => {
    expect(requireNeoMergeCurrent(input, state)).toEqual({ value: plan });
    for (const changed of [
      { ...input, sourceRevision: 2 },
      { ...input, targetRevision: 2 },
      { ...input, sourceId: 'missing' },
    ])
      expect(requireNeoMergeCurrent(changed, state)).toMatchObject({
        reason: { reason: 'superseded' },
      });
    expect(requireNeoMergeCurrent(input, { ...state, retired: ['target'] })).toMatchObject({
      reason: { reason: 'superseded' },
    });
  });
  test('rejects self, ancestry, sections, inbox and different parents', () => {
    expect(requireNeoMergeTree(plan, state)).toEqual({ value: plan });
    for (const changed of [
      { source, target: source },
      { source: { ...source, id: 'inbox' }, target },
      { source: { ...source, epicUrl: 'https://github.com/a/b/issues/1' }, target },
      { source: { ...source, parentId: 'target' }, target },
      { source, target: { ...target, parentId: 'source' } },
      { source: { ...source, parentId: 'missing' }, target },
    ])
      expect(
        requireNeoMergeTree(changed, { ...state, projects: [changed.source, changed.target] })
      ).toMatchObject({ reason: { reason: 'unsafe_tree' } });
  });
  test('requires equal complete identity sets or a human decision without conflict', () => {
    expect(requireNeoMergeIdentity(plan, input, state)).toEqual({ value: plan });
    expect(
      requireNeoMergeIdentity(plan, { ...input, sourceIdentities: [], targetIdentities: [] }, state)
    ).toMatchObject({ reason: { reason: 'needs_human' } });
    expect(
      requireNeoMergeIdentity(plan, { ...input, sourceIdentities: [], humanApproved: true }, state)
    ).toEqual({ value: plan });
    for (const targetIdentities of [[other], [identity, other], ['same remote']])
      expect(
        requireNeoMergeIdentity(plan, { ...input, targetIdentities, humanApproved: true }, state)
      ).toMatchObject({ reason: { reason: 'identity_conflict' } });
    expect(
      requireNeoMergeIdentity(plan, input, { ...state, identities: { source: [other] } })
    ).toMatchObject({ reason: { reason: 'identity_conflict' } });
    expect(state.projects).toEqual([source, target]);
  });
});

describe('createNeoProjectMergePipeline', () => {
  test('is synchronous and gates before writes', () => {
    let writes = 0;
    const run = createNeoProjectMergePipeline(
      () => state,
      () => {
        writes++;
        return { ok: true, sourceId: 'source', targetId: 'target' };
      }
    );
    expect(run({ ...input, sourceRevision: 2 })).toEqual({ ok: false, reason: 'superseded' });
    expect(writes).toBe(0);
    const success = createNeoProjectMergePipeline(
      () => state,
      () => {
        writes++;
        return { ok: true, sourceId: 'source', targetId: 'target' };
      }
    )(input);
    expect(success).toEqual({ ok: true, sourceId: 'source', targetId: 'target' });
    expect(writes).toBe(1);
    expect(success).not.toBeInstanceOf(Promise);
  });
});

let db: Database;
let repo: NeoRepository;
let directory: string;
let filename: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'neo-project-merge-'));
  filename = join(directory, 'test.db');
  db = new Database(filename);
  db.exec(
    'PRAGMA foreign_keys = ON; CREATE TABLE sessions(id TEXT PRIMARY KEY, processing_state TEXT)'
  );
  createNeoTables(db);
  runMigration361(db);
  runMigration387(db);
  repo = new NeoRepository(db);
  for (const id of ['source', 'target', 'child', 'next'])
    repo.saveProject({ id, title: id, summary: id, context: id }, 0);
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
describe('Neo project merge storage', () => {
  test('the upgrade runner applies project merges independently of input receipt migration 369', () => {
    const upgrade = new Database(':memory:');
    try {
      createTables(upgrade);
      runMigrations(upgrade, () => {});
      upgrade.exec(
        "DROP TABLE neo_project_merges; DELETE FROM migration_markers WHERE key = 'migration_370'"
      );
      runMigrations(upgrade, () => {});
      expect(
        upgrade
          .prepare(
            "SELECT key FROM migration_markers WHERE key IN ('migration_369', 'migration_370') ORDER BY key"
          )
          .all()
      ).toEqual([{ key: 'migration_369' }, { key: 'migration_370' }]);
      expect(
        upgrade.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_project_merges'").get()
      ).toEqual({ name: 'neo_project_merges' });
      runMigrations(upgrade, () => {});
      expect(upgrade.prepare('SELECT * FROM neo_project_merges').all()).toEqual([]);
    } finally {
      upgrade.close();
    }
  });
  test('atomically preserves context, workspaces, sections and old publications', () => {
    repo.moveProject('child', 'source', 1);
    repo.reserveBinding({ sessionId: 'worker', projectId: 'source', kind: 'worker' });
    db.prepare('INSERT INTO neo_project_workspaces VALUES (?, ?)').run(identity, 'source');
    db.exec(`INSERT INTO neo_publications(conversation_id, publication_id, payload_json, created_at)
      VALUES ('source', 'old', '{"projectId":"source","text":"history"}', 'yesterday')`);
    expect(repo.projectMerges.merge(input)).toEqual({
      ok: true,
      sourceId: 'source',
      targetId: 'target',
    });
    expect(repo.projectMerges.resolve('source')).toBe('target');
    expect(repo.getProject('source')?.context).toBe('source');
    expect(repo.getProject('target')).toMatchObject({
      context: 'target\n\nsource',
      summary: 'target\n\nsource',
      revision: 2,
    });
    expect(repo.getProject('child')).toMatchObject({ parentId: 'target', revision: 3 });
    expect(repo.getBindingBySession('worker')?.projectId).toBe('target');
    expect(db.prepare('SELECT project_id FROM neo_project_workspaces').get()).toEqual({
      project_id: 'target',
    });
    expect(db.prepare('SELECT payload_json FROM neo_publications').get()).toEqual({
      payload_json: '{"projectId":"source","text":"history"}',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(repo.projectMerges.merge(input)).toEqual({ ok: false, reason: 'superseded' });
  });
  test('keeps redirects across later merges and migration reapplication', () => {
    expect(repo.projectMerges.merge(input).ok).toBe(true);
    expect(
      repo.projectMerges.merge({
        ...input,
        sourceId: 'target',
        sourceRevision: 2,
        targetId: 'next',
      }).ok
    ).toBe(true);
    runMigration370(db);
    expect(new NeoRepository(db).projectMerges.resolve('source')).toBe('next');
    expect(repo.projectMerges.resolve('missing')).toBeNull();
    db.exec("UPDATE neo_project_merges SET target_id = 'source' WHERE source_id = 'target'");
    expect(repo.projectMerges.resolve('source')).toBeNull();
  });
  test('stored identities cannot be overridden by proposed evidence or approval', () => {
    db.prepare('INSERT INTO neo_project_workspaces VALUES (?, ?)').run(other, 'source');
    expect(repo.projectMerges.merge({ ...input, humanApproved: true })).toEqual({
      ok: false,
      reason: 'identity_conflict',
    });
    expect(db.prepare('SELECT * FROM neo_project_merges').all()).toEqual([]);
  });
  test('notifies once after a successful commit, never on admission rejection or rollback', () => {
    const committed: string[] = [];
    repo = new NeoRepository(db, () => {
      const observer = new Database(filename);
      try {
        expect(new NeoRepository(observer).projectMerges.resolve('source')).toBe('target');
      } finally {
        observer.close();
      }
      committed.push(repo.projectMerges.resolve('source')!);
    });
    expect(repo.projectMerges.merge({ ...input, sourceRevision: 2 }).ok).toBe(false);
    expect(committed).toEqual([]);
    db.exec(`CREATE TRIGGER fail_notify_merge BEFORE UPDATE ON neo_concerns WHEN NEW.id = 'target'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    expect(() => repo.projectMerges.merge(input)).toThrow('injected failure');
    expect(committed).toEqual([]);
    db.exec('DROP TRIGGER fail_notify_merge');
    expect(repo.projectMerges.merge(input).ok).toBe(true);
    expect(committed).toEqual(['target']);
    expect(repo.projectMerges.merge(input).ok).toBe(false);
    expect(committed).toEqual(['target']);
  });
  test('rolls back all prior writes when a storage effect fails', () => {
    db.exec(`CREATE TRIGGER fail_merge BEFORE UPDATE ON neo_concerns WHEN NEW.id = 'target'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    expect(() => repo.projectMerges.merge(input)).toThrow('injected failure');
    expect(db.prepare('SELECT * FROM neo_project_merges').all()).toEqual([]);
    expect(repo.projectMerges.resolve('source')).toBe('source');
  });
});
