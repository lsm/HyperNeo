import { describe, expect, test } from 'bun:test';
import { CODING_ATTENTION_KINDS } from '../../../../src/lib/neo/packs/coding/attention.ts';
import { createCodingPack } from '../../../../src/lib/neo/packs/coding/pack.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrEventRepository } from '../../../../src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrSweepRepository } from '../../../../src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingTodoPrRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';
import { neoAttentionNotes } from '../../helpers/neo-attention-notes.ts';

const repo = 'synthetic/health';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = 10_000_000;
const STALLED = `GitHub coverage stalled for ${repo}. Incident github-health:${repo}:${T0}.`;

async function using(
  run: (world: {
    db: Database;
    sweep: (at: number, complete?: boolean) => Promise<void>;
    digests: () => string[];
    wakes: () => string[];
  }) => Promise<void>
) {
  const db = new Database(':memory:');
  createTables(db);
  runMigrations(db, () => {});
  createCodingPackTables(db);
  const notes = neoAttentionNotes(db, new NeoAskTodoRepository(db), () => {}, [
    ...CODING_ATTENTION_KINDS,
  ]);
  let clock = T0;
  let complete = false;
  const pack = createCodingPack({
    database: () => db,
    readPrs: async () => [],
    todoPrs: new CodingTodoPrRepository(db),
    prLedger: new CodingPrLedgerRepository(db),
    prEvents: new CodingPrEventRepository(db),
    prSweep: new CodingPrSweepRepository(db),
    attend: async (event) => 'told' in (await notes.tell(event, clock)),
    prSweepDeps: {
      tell: async () => true,
      wake: async () => {
        throw new Error('health must not wake Neo directly');
      },
    },
    projectRepos: () => [repo],
    readLedgerRepo: async () =>
      complete
        ? {
            data: {
              rateLimit: { remaining: 4000 },
              repository: {
                nameWithOwner: repo,
                open: { pageInfo: { hasNextPage: false }, nodes: [] },
                done: { nodes: [] },
              },
            },
          }
        : null,
  });
  try {
    await run({
      db,
      sweep: async (at, done = false) => {
        clock = at;
        complete = done;
        await pack.sweep!(at);
      },
      digests: () => notes.digests().map((text) => text.split('\n\n')[0]),
      wakes: notes.wakes,
    });
  } finally {
    db.close();
  }
}

describe('GitHub health reaches Neo through the attention entry', () => {
  test('a stalled repository is one digest, one more a day later, and nothing after recovery', () =>
    using(async ({ db, sweep, digests, wakes }) => {
      for (const minutes of [0, 5, 10]) await sweep(T0 + minutes * MIN);
      for (const minutes of [15, 60, 23 * 60]) await sweep(T0 + minutes * MIN);
      expect(digests()).toEqual([STALLED]);
      await sweep(T0 + 10 * MIN + DAY);
      expect(digests()).toEqual([STALLED, STALLED]);
      await sweep(T0 + 10 * MIN + DAY + 5 * MIN, true);
      await sweep(T0 + 10 * MIN + 2 * DAY, true);
      expect(digests()).toEqual([STALLED, STALLED]);
      expect(wakes()).toEqual([]);
      expect(
        (
          db.prepare('SELECT health_json FROM pack_coding_repo_health').all() as {
            health_json: string;
          }[]
        ).some((row) => JSON.parse(row.health_json).notices !== undefined)
      ).toBe(false);
    }));

  test('an approved pull request whose readiness read stalls is one digest until a complete read', () =>
    using(async ({ db, sweep, digests }) => {
      new CodingPrLedgerRepository(db).replace(
        repo,
        [
          {
            repo,
            number: 1,
            title: 'Ready after CI',
            branch: 'topic',
            head: 'approved-head',
            state: 'approved_pending',
            closedAt: null,
          },
        ],
        T0
      );
      await sweep(T0 + 5 * MIN);
      expect(digests()).toEqual([]);
      await sweep(T0 + 15 * MIN);
      await sweep(T0 + 20 * MIN);
      const pending = `GitHub readiness observation stalled for ${repo}#1 (approved_pending, head approve) since ${new Date(T0).toISOString()}. Current CI is unverified; check polling before acting.`;
      expect(digests().filter((text) => text.startsWith('GitHub readiness'))).toEqual([pending]);
      await sweep(T0 + 25 * MIN, true);
      await sweep(T0 + 25 * MIN + DAY);
      expect(digests().filter((text) => text === pending)).toHaveLength(1);
    }));
});
