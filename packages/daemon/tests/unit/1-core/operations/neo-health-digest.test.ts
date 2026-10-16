import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { neoHealthDigest } from '../../../../src/lib/neo/health-digest.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTestDb } from '../../../helpers/database.ts';

const since = Date.UTC(2026, 9, 15);

describe('neoHealthDigest', () => {
  test('states the facts, what cleanup did and what it left, and which asks went untouched', () => {
    const digest = neoHealthDigest(
      {
        projects: 14,
        projectsCreated: 2,
        projectsMerged: 1,
        holders: 5,
        holdersOpened: 2,
        routing: [
          { signal: 'classifier-failed', count: 31 },
          { signal: 'facts', count: 7 },
        ],
        refusals: [],
        liveAsks: [
          { id: 'a1', title: 'Old', status: 'waiting', updatedAt: since - 1 },
          { id: 'a2', title: 'Fresh', status: 'open', updatedAt: since + 1 },
        ],
      },
      {
        cleanupPlanned: [
          { action: 'drop', projectId: 'p', title: 'P', sessionId: 's' },
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
      'Project holder sessions: 5 live, 2 opened.',
      'Cleanup done tonight: drop P (p).',
      'Cleanup failed tonight: x: busy.',
      'Cleanup that touches content, not applied: merge Q (q) into r.',
      'Routing by signal: classifier-failed 31, facts 7.',
      'Card refusals by what was refused: none.',
      `Live asks: a1 "Old" waiting, last changed ${new Date(since - 1).toISOString()} (untouched since the last digest); a2 "Fresh" open, last changed ${new Date(since + 1).toISOString()}.`,
    ]);
  });
});

describe('NeoRepository.healthFacts', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(() => db.close());

  test('counts projects, merges and routing since a time', () => {
    const repo = new NeoRepository(db.getDatabase());
    repo.saveProject({ id: 'p', title: 'P', summary: '', context: '' }, 0);
    db.getDatabase()
      .prepare(`INSERT INTO neo_routing_log (message_id, conversation_id, asked_at, ask, destination, signal)
        VALUES ('m1', 'c', ?, 'hi', 'main', 'classifier-failed'), ('m2', 'c', ?, 'hi', 'main', 'facts')`)
      .run(since + 1, since - 1);
    expect(repo.healthFacts(since)).toMatchObject({
      projectsMerged: 0,
      holders: 0,
      routing: [{ signal: 'classifier-failed', count: 1 }],
      refusals: [],
      liveAsks: [],
    });
  });
});
