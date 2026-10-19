import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NeoWorkPrRepository } from '../../../../src/lib/neo/packs/coding/neo-work-pr-repository.ts';
import { runMigration365 } from '../../../../src/storage/schema/m365-neo-cross-project-dispatch.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NeoConsultationWaiterRepository } from '../../../../src/storage/repositories/neo-consultation-waiter-repository.ts';
import { NeoConsultationRepository } from '../../../../src/storage/repositories/neo-consultation-repository.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import {
  NeoCrossProjectRepository,
  neoCrossProjectReplyId,
} from '../../../../src/storage/repositories/neo-cross-project-repository.ts';
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

describe('NeoCrossProjectRepository', () => {
  test('binds every waiter atomically and retries aggregate publications by identity', () => {
    const sql = db.getDatabase();
    const groups = new NeoCrossProjectRepository(sql);
    const waiters = new NeoConsultationWaiterRepository(sql, () => {});
    const consultations = new NeoConsultationRepository(sql, () => {});
    const parts = ['alpha', 'beta'].map((projectId) => ({
      projectId,
      quote: projectId,
      question: 'Review',
    }));
    const ask = { sessionId: 'root', messageId: 'human' };
    const sessions = new Map([
      ['alpha', 'holder-alpha'],
      ['beta', 'holder-beta'],
    ]);
    const bound = groups.bind('root', 'human', ask, parts, sessions, waiters);
    expect('value' in bound).toBe(true);
    if (!('value' in bound)) throw new Error(bound.reason);
    const group = bound.value;
    expect(groups.members(group)).toHaveLength(2);
    expect(groups.bind('root', 'human', ask, [...parts].reverse(), sessions, waiters)).toEqual({
      value: group,
    });
    expect(
      groups.bind(
        'root',
        'human',
        ask,
        [{ ...parts[0], question: 'Changed' }, parts[1]],
        sessions,
        waiters
      )
    ).toEqual({ reason: 'cross_project_conflict' });
    const input = {
      conversationId: crypto.randomUUID(),
      publicationId: crypto.randomUUID(),
      askOrigin: ask,
      producerInput: { sessionId: 'root', messageId: neoCrossProjectReplyId(group) },
      shortText: 'Both finished',
      fullText: 'Both finished',
      links: [],
      triggerId: `human:${ask.messageId}`,
    };
    expect(groups.ready(group)).toBe(false);
    expect(groups.publicationProblem(input)).toBeNull();
    for (const member of groups.members(group)) {
      expect(waiters.admitNext(member.projectId)?.id).toBe(member.id);
      consultations.finish(member.id, 'reported', `${member.projectId} done`);
    }
    const reopened = new NeoCrossProjectRepository(sql);
    expect(reopened.ready(group)).toBe(true);
    const ledger = new NeoPublicationRepository(sql);
    expect(reopened.append(input, () => ledger.append(input))).toMatchObject({
      accepted: true,
      created: true,
    });
    expect(reopened.append(input, () => ledger.append(input))).toMatchObject({
      accepted: true,
      created: false,
    });
    const sameText = { ...input, publicationId: crypto.randomUUID() };
    expect(reopened.publicationProblem(sameText)).toBeNull();
    expect(reopened.append(sameText, () => ledger.append(sameText))).toMatchObject({
      accepted: true,
      created: true,
      publication: { publicationId: sameText.publicationId },
    });
    const changed = {
      ...sameText,
      publicationId: crypto.randomUUID(),
      shortText: 'A different aggregate.',
    };
    expect(reopened.append(changed, () => ledger.append(changed))).toMatchObject({
      accepted: true,
      created: true,
    });
    expect(reopened.forAsk(input.askOrigin)?.publicationId).toBe(changed.publicationId);
  });
  test('rolls back the group and all queued parts when a membership write fails', () => {
    const sql = db.getDatabase();
    const groups = new NeoCrossProjectRepository(sql);
    sql.exec(
      `CREATE TRIGGER fail_cross_part BEFORE INSERT ON neo_cross_project_dispatch_members WHEN NEW.project_id = 'beta' BEGIN SELECT RAISE(ABORT, 'injected'); END`
    );
    expect(() =>
      groups.bind(
        'root',
        'human',
        { sessionId: 'root', messageId: 'human' },
        ['alpha', 'beta'].map((projectId) => ({ projectId, quote: projectId, question: 'Review' })),
        new Map([
          ['alpha', 'a'],
          ['beta', 'b'],
        ]),
        new NeoConsultationWaiterRepository(sql, () => {})
      )
    ).toThrow('injected');
    expect(groups.pending()).toEqual([]);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM neo_consultation_waiters').get()).toEqual({
      n: 0,
    });
  });
});
