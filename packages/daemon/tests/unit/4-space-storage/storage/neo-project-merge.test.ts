import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration279 } from '../../../../src/storage/schema/m279-neo-consultations.ts';
import { runMigration285 } from '../../../../src/storage/schema/m285-neo-consultation-waiters.ts';
import { runMigration313 } from '../../../../src/storage/schema/m313-neo-asks.ts';
import { runMigration361 } from '../../../../src/storage/schema/m361-neo-project-avatars.ts';
import { runMigration369 } from '../../../../src/storage/schema/m369-neo-project-merges.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import {
  createNeoProjectMergePipeline,
  requireNeoMergeCurrent,
  requireNeoMergeTree,
  requireNeoMergeIdle,
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
  unavailable: [],
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
  test('rejects either unavailable project', () => {
    expect(requireNeoMergeIdle(plan, state)).toEqual({ value: plan });
    for (const id of ['source', 'target'])
      expect(requireNeoMergeIdle(plan, { ...state, unavailable: [id] })).toMatchObject({
        reason: { reason: 'project_busy' },
      });
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
  test('is synchronous and gates before writes, with stale precedence over busy', () => {
    let writes = 0;
    const run = createNeoProjectMergePipeline(
      () => ({ ...state, unavailable: ['source'] }),
      () => {
        writes++;
        return { ok: true, sourceId: 'source', targetId: 'target' };
      }
    );
    expect(run({ ...input, sourceRevision: 2 })).toEqual({ ok: false, reason: 'superseded' });
    expect(run(input)).toEqual({ ok: false, reason: 'project_busy' });
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
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(
    'PRAGMA foreign_keys = ON; CREATE TABLE sessions(id TEXT PRIMARY KEY, processing_state TEXT)'
  );
  createNeoTables(db);
  runMigration279(db);
  runMigration285(db);
  runMigration313(db);
  runMigration361(db);
  repo = new NeoRepository(db);
  for (const id of ['source', 'target', 'child', 'next'])
    repo.saveProject({ id, title: id, summary: id, context: id }, 0);
  repo.reserveBinding({ sessionId: 'avatar', projectId: 'source', kind: 'project' });
  db.exec("INSERT INTO sessions VALUES ('avatar', NULL)");
});
afterEach(() => db.close());
const askRow = (status = 'open') =>
  db
    .prepare(`INSERT INTO neo_asks
  (id, request_key, concern_id, origin_session_id, title, ask, done_when, done_source, status, created_at, updated_at)
  VALUES ('ask', 'ask', 'source', 'human', 'ask', 'ask', 'done', 'human', ?, 1, 1)`)
    .run(status);

describe('Neo project merge storage', () => {
  test('atomically preserves context, workspaces, asks, cards, sections and old publications', () => {
    askRow();
    db.exec(`INSERT INTO neo_work(id, request_key, concern_id, origin_session_id, title, instruction, status, created_at, updated_at)
      VALUES ('work', 'work', 'source', 'human', 'work', 'do', 'queued', 1, 1)`);
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
    for (const table of ['neo_asks', 'neo_work'])
      expect(db.prepare(`SELECT concern_id, origin_session_id FROM ${table}`).get()).toEqual({
        concern_id: 'target',
        origin_session_id: 'human',
      });
    expect(repo.getBindingForProject('source')).toBeNull();
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
    runMigration369(db);
    expect(new NeoRepository(db).projectMerges.resolve('source')).toBe('next');
    expect(repo.projectMerges.resolve('missing')).toBeNull();
    db.exec("UPDATE neo_project_merges SET target_id = 'source' WHERE source_id = 'target'");
    expect(repo.projectMerges.resolve('source')).toBeNull();
  });
  test('busy and malformed processing states and human questions prevent writes', () => {
    for (const processing of [
      '{"status":"processing"}',
      '{"status":"interrupted"}',
      'broken json',
    ]) {
      db.prepare('UPDATE sessions SET processing_state = ?').run(processing);
      expect(repo.projectMerges.merge(input)).toEqual({ ok: false, reason: 'project_busy' });
    }
    db.exec('UPDATE sessions SET processing_state = \'{"status":"idle"}\'');
    askRow('waiting');
    expect(repo.projectMerges.merge(input)).toEqual({ ok: false, reason: 'project_busy' });
    expect(db.prepare('SELECT * FROM neo_project_merges').all()).toEqual([]);
    expect(repo.getProject('target')?.revision).toBe(1);
  });
  test('stored identities cannot be overridden by proposed evidence or approval', () => {
    db.prepare('INSERT INTO neo_project_workspaces VALUES (?, ?)').run(other, 'source');
    expect(repo.projectMerges.merge({ ...input, humanApproved: true })).toEqual({
      ok: false,
      reason: 'identity_conflict',
    });
    expect(db.prepare('SELECT * FROM neo_project_merges').all()).toEqual([]);
  });
  test('pending consultations and queued consultation waiters prevent retirement', () => {
    db.exec(`INSERT INTO neo_consultations(id, request_key, concern_id, origin_session_id, session_id, question, status, created_at)
      VALUES ('consult', 'consult', 'target', 'human', 'avatar', 'question', 'pending', 1)`);
    expect(repo.projectMerges.merge(input)).toEqual({ ok: false, reason: 'project_busy' });
    db.exec("UPDATE neo_consultations SET status = 'reported'");
    db.exec(`INSERT INTO neo_consultation_waiters(id, request_key, concern_id, origin_session_id, origin_message_id, session_id, question, status, created_at)
      VALUES ('waiter', 'waiter', 'source', 'human', 'message', 'avatar', 'question', 'queued', 1)`);
    expect(repo.projectMerges.merge(input)).toEqual({ ok: false, reason: 'project_busy' });
    db.exec("UPDATE neo_consultation_waiters SET status = 'cancelled'");
    expect(repo.projectMerges.merge(input).ok).toBe(true);
    expect(db.prepare('SELECT concern_id FROM neo_consultation_waiters').get()).toEqual({
      concern_id: 'target',
    });
  });
  test('rolls back all prior writes when a storage effect fails', () => {
    askRow();
    db.exec(`CREATE TRIGGER fail_merge BEFORE UPDATE ON neo_concerns WHEN NEW.id = 'target'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    expect(() => repo.projectMerges.merge(input)).toThrow('injected failure');
    expect(db.prepare('SELECT * FROM neo_project_merges').all()).toEqual([]);
    expect(db.prepare('SELECT concern_id FROM neo_asks').get()).toEqual({ concern_id: 'source' });
    expect(repo.getBindingForProject('source')?.sessionId).toBe('avatar');
  });
});
