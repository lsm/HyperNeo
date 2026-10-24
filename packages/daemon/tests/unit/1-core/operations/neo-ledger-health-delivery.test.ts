import { describe, expect, test } from 'bun:test';
import { createCodingPack } from '../../../../src/lib/neo/packs/coding/pack.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrEventRepository } from '../../../../src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrSweepRepository } from '../../../../src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingTodoPrRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

const repo = 'synthetic/health';
type Wake = (key: string, text: string) => Promise<boolean>;
type Pack = (wake: Wake, complete?: boolean) => ReturnType<typeof createCodingPack>;
async function using(run: (db: Database, pack: Pack) => Promise<void>) {
  const db = new Database(':memory:');
  createTables(db);
  runMigrations(db, () => {});
  createCodingPackTables(db);
  const pack: Pack = (wake, complete = false) =>
    createCodingPack({
      database: () => db,
      readPrs: async () => [],
      readClaudeOwners: async () => [],
      todoPrs: new CodingTodoPrRepository(db),
      prLedger: new CodingPrLedgerRepository(db),
      prEvents: new CodingPrEventRepository(db),
      prSweep: new CodingPrSweepRepository(db),
      prSweepDeps: { tell: async () => true, wake },
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
    await run(db, pack);
  } finally {
    db.close();
  }
}
const notices = (db: Database) =>
  JSON.parse(
    (
      db.prepare('SELECT health_json FROM pack_coding_repo_health WHERE repo=?').get(repo) as {
        health_json: string;
      }
    ).health_json
  ).notices ?? [];

describe('repository health delivery', () => {
  test('an existing active health record without notice metadata is delivered on its next sweep', () =>
    using(async (db, pack) => {
      const ledger = new CodingPrLedgerRepository(db);
      for (const at of [1, 2, 3]) ledger.recordHealth(repo, { at, outcome: 'failed' });
      db.exec(
        "UPDATE pack_coding_repo_health SET health_json=json_remove(health_json,'$.notices')"
      );
      const keys: string[] = [];
      await pack(async (key) => {
        keys.push(key);
        return true;
      }).sweep!(4);
      expect(keys).toEqual(['github-health:synthetic/health:1']);
      expect(notices(db)).toHaveLength(1);
      expect(notices(db)[0].acceptedAt).toBe(4);
    }));
  test('the third miss wakes once and accepted state survives pack reconstruction and recovery', () =>
    using(async (db, pack) => {
      const calls: { key: string; text: string }[] = [];
      const wake: Wake = async (key, text) => {
        calls.push({ key, text });
        return true;
      };
      for (const at of [1, 2]) await pack(wake).sweep!(at);
      expect(calls).toEqual([]);
      await pack(wake).sweep!(3);
      expect(calls).toHaveLength(1);
      expect(calls[0].key).toBe('github-health:synthetic/health:1');
      expect(calls[0].text).toContain(repo);
      expect(notices(db)[0].acceptedAt).toBe(3);
      for (const at of [3, 4]) await pack(wake).sweep!(at);
      expect(calls).toHaveLength(1);
      await pack(wake, true).sweep!(5);
      expect(calls.map((call) => call.key)).toEqual([calls[0].key, `${calls[0].key}:recovery`]);
      expect(notices(db)[1].acceptedAt).toBe(5);
      await pack(wake, true).sweep!(6);
      expect(calls).toHaveLength(2);
    }));
  test('rejection and thrown wake retain ordered notices across recovery and a later incident', () =>
    using(async (db, pack) => {
      const calls: { key: string; text: string }[] = [];
      let accept = false;
      const wake: Wake = async (key, text) => {
        calls.push({ key, text });
        if (!accept && calls.length === 2) throw new Error('synthetic rejection');
        return accept;
      };
      for (const at of [1, 2, 3]) await pack(wake).sweep!(at);
      expect(calls).toHaveLength(1);
      await pack(wake, true).sweep!(4);
      for (const at of [5, 6, 7]) await pack(wake).sweep!(at);
      expect(calls.every((call) => JSON.stringify(call) === JSON.stringify(calls[0]))).toBe(true);
      expect(notices(db)).toHaveLength(3);
      expect(
        notices(db).every((notice: { acceptedAt: number | null }) => notice.acceptedAt === null)
      ).toBe(true);
      accept = true;
      const attempted = calls.length;
      await pack(wake).sweep!(8);
      expect(calls.slice(attempted).map((call) => call.key)).toEqual([
        calls[0].key,
        `${calls[0].key}:recovery`,
        'github-health:synthetic/health:5',
      ]);
      expect(
        notices(db).every((notice: { acceptedAt: number | null }) => notice.acceptedAt === 8)
      ).toBe(true);
    }));
  test('accepted wake followed by failed bookkeeping retries the same body without losing current health', () =>
    using(async (db, pack) => {
      const received = new Map<string, string>(),
        calls: string[] = [];
      const wake: Wake = async (key, text) => {
        expect(received.get(key) ?? text).toBe(text);
        received.set(key, text);
        calls.push(key);
        return true;
      };
      db.exec(
        "CREATE TRIGGER reject_health_ack BEFORE UPDATE ON pack_coding_repo_health WHEN json_extract(NEW.health_json,'$.notices[0].acceptedAt') IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic ack failure'); END"
      );
      for (const at of [1, 2]) await pack(wake).sweep!(at);
      await expect(pack(wake).sweep!(3)).rejects.toThrow('synthetic ack failure');
      expect(received.size).toBe(1);
      expect(notices(db)[0].acceptedAt).toBeNull();
      db.exec('DROP TRIGGER reject_health_ack');
      await pack(wake).sweep!(4);
      expect(calls).toEqual([calls[0], calls[0]]);
      expect(received.size).toBe(1);
      expect(new CodingPrLedgerRepository(db).health.read(repo)?.misses).toBe(4);
      expect(notices(db)[0].acceptedAt).toBe(4);
    }));
});
