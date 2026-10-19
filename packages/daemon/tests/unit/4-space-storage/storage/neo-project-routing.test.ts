import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NeoWorkPrRepository } from '../../../../src/lib/neo/packs/coding/neo-work-pr-repository.ts';
import { runMigration365 } from '../../../../src/storage/schema/m365-neo-cross-project-dispatch.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import {
  readNeoProjectFacts,
  neoFactOwners,
  neoRepoAlias,
} from '../../../../src/lib/neo/project-route-facts.ts';

let db: Database;
let repo: NeoRepository;
beforeEach(async () => {
  db = await createTestDb();
  repo = new NeoRepository(db.getDatabase());
  for (const id of ['alpha', 'beta'])
    repo.saveProject({ id, title: id, summary: '', context: '' }, 0);
});
afterEach(() => db.close());

function work(id: string, projectId: string | null) {
  return repo.proposeWork({
    id,
    requestKey: id,
    projectId,
    originSessionId: 'root',
    title: id,
    instruction: id,
  });
}

describe('readNeoProjectFacts', () => {
  test('backfills PR references and keeps them synchronized with recorded PR changes', () => {
    work('card-one', 'alpha');
    const sql = db.getDatabase();
    const prs = new NeoWorkPrRepository(sql);
    prs.record(
      'card-one',
      [
        {
          url: 'https://github.com/lsm/HyperNeo/pull/99',
          state: 'OPEN',
          checks: 'none',
          review: 'none',
        },
      ],
      0
    );
    sql.exec('DELETE FROM neo_route_pr_refs');
    runMigration365(sql);
    expect(neoFactOwners(readNeoProjectFacts(sql, 'lsm/HyperNeo#99 and #99'))).toEqual(['alpha']);
    prs.replacePrs('card-one', []);
    expect(neoFactOwners(readNeoProjectFacts(sql, '#99'))).toBeNull();
  });
  test('uses indexed lookups for only the references present in the message', () => {
    work('card-one', 'alpha');
    db.createSession(createTestSession('linked-session'));
    const sql = db.getDatabase();
    const queries = new Set<string>();
    const tracked = {
      prepare: (query: string) => {
        queries.add(query);
        return sql.prepare(query);
      },
    } as typeof sql;
    expect(
      neoFactOwners(
        readNeoProjectFacts(tracked, 'card-one linked-session /missing unknown/repo#99 #99')
      )
    ).toBeNull();
    for (const query of queries) {
      const plans = sql
        .prepare(`EXPLAIN QUERY PLAN ${query}`)
        .all(...Array.from(query.matchAll(/\?/g), () => null)) as { detail: string }[];
      expect(plans.map((plan) => plan.detail).join('\n')).not.toMatch(/\bSCAN\b/);
    }
  });
  test('uses exact object identities and combines owners without matching ID prefixes', () => {
    work('card-one', 'alpha');
    work('card-two', 'beta');
    expect(
      neoFactOwners(readNeoProjectFacts(db.getDatabase(), 'finish card-one then card-two'))
    ).toEqual(['alpha', 'beta']);
    expect(readNeoProjectFacts(db.getDatabase(), 'card-one-more')).toEqual([]);
  });
  test('uses the linked session folder and named repository issues before text', () => {
    const session = createTestSession('linked-session');
    session.workspacePath = '/alpha';
    db.createSession(session);
    db.getDatabase()
      .prepare('INSERT INTO neo_project_workspaces VALUES (?, ?)')
      .run('folder:laptop\u0000/alpha', 'alpha');
    db.getDatabase()
      .prepare('INSERT INTO neo_project_workspaces VALUES (?, ?)')
      .run('repo:lsm/hyperneo\u0000git:123', 'alpha');
    expect(
      neoFactOwners(readNeoProjectFacts(db.getDatabase(), 'beta words but linked-session'))
    ).toEqual(['alpha']);
    expect(
      neoFactOwners(
        readNeoProjectFacts(db.getDatabase(), 'https://github.com/lsm/HyperNeo/issues/6760')
      )
    ).toEqual(['alpha']);
    expect(neoFactOwners(readNeoProjectFacts(db.getDatabase(), 'lsm/HyperNeo#6760'))).toEqual([
      'alpha',
    ]);
    expect(neoFactOwners(readNeoProjectFacts(db.getDatabase(), '/alpha'))).toEqual(['alpha']);
  });
  test('uses external driver session aliases and fails closed on unknown links', () => {
    db.getDatabase()
      .prepare('INSERT INTO neo_project_workspaces VALUES (?, ?)')
      .run('work:remote\u0000codex-desktop\u0000external-session', 'beta');
    expect(neoFactOwners(readNeoProjectFacts(db.getDatabase(), 'external-session'))).toEqual([
      'beta',
    ]);
    expect(
      neoFactOwners(readNeoProjectFacts(db.getDatabase(), 'https://github.com/unknown/repo/pull/2'))
    ).toBeNull();
    expect(
      neoFactOwners(readNeoProjectFacts(db.getDatabase(), '10000000-0000-4000-8000-000000000001'))
    ).toBeNull();
  });
  test('keeps root-owned cards at root and refuses ambiguous remote links', () => {
    work('root-card', null);
    expect(neoFactOwners(readNeoProjectFacts(db.getDatabase(), 'root-card'))).toEqual([null]);
    for (const id of ['alpha', 'beta'])
      db.getDatabase()
        .prepare('INSERT INTO neo_project_workspaces VALUES (?, ?)')
        .run(`repo:lsm/shared\u0000${id}`, id);
    expect(neoFactOwners(readNeoProjectFacts(db.getDatabase(), 'lsm/shared#2'))).toBeNull();
  });
});

describe('neoRepoAlias', () => {
  test('normalizes GitHub remote links without making them code identities', () => {
    expect(neoRepoAlias('git@github.com:LSM/HyperNeo.git')).toBe('repo:lsm/hyperneo\u0000');
    expect(neoRepoAlias('https://github.com/lsm/HyperNeo.git')).toBe('repo:lsm/hyperneo\u0000');
    expect(neoRepoAlias('/local/repo')).toBeNull();
  });
});
