import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { neoHealthDigest } from '../../../../src/lib/neo/health-digest.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { OperationRefusalRepository } from '../../../../src/storage/repositories/operation-refusal-repository.ts';
import { createTestDb } from '../../../helpers/database.ts';

const since = Date.UTC(2026, 9, 15);

describe('neoHealthDigest', () => {
  test('states the facts, what cleanup did and what it left, and which asks went untouched', () => {
    const digest = neoHealthDigest(
      {
        projects: 14,
        projectsCreated: 2,
        projectsMerged: 1,
        refusals: [],
        doorRefusals: [{ operation: 'neo.ask.open', reason: 'invalid_input', count: 3 }],
        repeatedReplies: [{ trigger: 'neo-turn-limit:r1', count: 4 }],
        liveAsks: [
          { id: 'a1', title: 'Old', status: 'waiting', updatedAt: since - 1 },
          { id: 'a2', title: 'Fresh', status: 'open', updatedAt: since + 1 },
        ],
        unreadRepos: [{ repo: 'lsm/private', error: 'Not Found' }],
      },
      {
        cleanupPlanned: [
          { action: 'delete', projectId: 'p', title: 'P' },
          { action: 'delete', projectId: 'x', title: 'X' },
          { action: 'merge', projectId: 'q', title: 'Q', targetId: 'r' },
        ],
        cleanupFailed: [{ projectId: 'x', reason: 'busy' }],
      },
      since
    );
    expect(digest.split('\n')).toEqual([
      'Nightly health digest since 2026-10-15T00:00:00.000Z. Facts only.',
      'Projects: 14 now, 2 created, 1 merged away.',
      'Cleanup done tonight: delete P (p).',
      'Cleanup failed tonight: x: busy.',
      'Merges asked of the human, not applied: merge Q (q) into r.',
      'Card refusals by what was refused: none.',
      'Operation refusals at the agent door by operation and reason: neo.ask.open invalid_input 3.',
      'Triggers that got more than one message: neo-turn-limit:r1 4.',
      `Live asks: a1 "Old" waiting, last changed ${new Date(since - 1).toISOString()} (untouched since the last digest); a2 "Fresh" open, last changed ${new Date(since + 1).toISOString()}.`,
      'Watched GitHub repos whose last poll failed: lsm/private: Not Found.',
    ]);
  });
});

describe('NeoRepository.healthFacts', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(() => db.close());

  test('counts projects and merges since a time', () => {
    const repo = new NeoRepository(db.getDatabase());
    repo.saveProject({ id: 'p', title: 'P', summary: '', context: '' }, 0);
    expect(repo.healthFacts(since)).toMatchObject({
      projectsMerged: 0,
      refusals: [],
      liveAsks: [],
      unreadRepos: [],
    });
  });

  test('lists watched repos whose last poll failed, and only those still polled', () => {
    const repo = new NeoRepository(db.getDatabase());
    const insert = db.getDatabase().prepare(
      `INSERT INTO space_github_watched_repos (id, space_id, owner, repo, enabled, polling_enabled, poll_cursor, created_at, updated_at)
        VALUES (?, 'sessions', 'lsm', ?, 1, ?, ?, 0, 0)`
    );
    insert.run('w1', 'private', 1, JSON.stringify({ lastPollError: 'Not Found' }));
    insert.run('w2', 'open', 1, JSON.stringify({ lastPollError: null }));
    insert.run('w3', 'off', 0, JSON.stringify({ lastPollError: 'Not Found' }));
    expect(repo.healthFacts(since).unreadRepos).toEqual([
      { repo: 'lsm/private', error: 'Not Found' },
    ]);
  });

  test('groups door refusals since a time and finds triggers with several messages', () => {
    const repo = new NeoRepository(db.getDatabase());
    const refusals = new OperationRefusalRepository(db.getDatabase());
    refusals.record({ operation: 'neo.ask.open', reason: 'invalid_input' }, 's', since + 1);
    refusals.record({ operation: 'neo.ask.open', reason: 'invalid_input' }, 's', since + 2);
    refusals.record({ operation: 'work.start', reason: 'busy' }, 's', since - 1);
    const publish = (id: string, trigger: string, extra: object = {}, at = since + 1) =>
      db
        .getDatabase()
        .prepare(
          'INSERT INTO neo_publications (conversation_id, publication_id, payload_json, created_at) VALUES (?, ?, ?, ?)'
        )
        .run(
          'c',
          id,
          JSON.stringify({ producerInput: { messageId: trigger }, ...extra }),
          new Date(at).toISOString()
        );
    publish('p1', 't1');
    publish('p2', 't1');
    publish('p3', 't1', { interim: true });
    publish('p4', 't2');
    publish('p5', 't2', { corrects: 'p4' });
    publish('p6', 't3', {}, since - 1);
    publish('p7', 't3');
    expect(repo.healthFacts(since)).toMatchObject({
      doorRefusals: [{ operation: 'neo.ask.open', reason: 'invalid_input', count: 2 }],
      repeatedReplies: [
        { trigger: 't1', count: 3 },
        { trigger: 't2', count: 2 },
      ],
    });
  });
});
