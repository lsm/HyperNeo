import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { createCodingPack } from '../../../../src/lib/neo/packs/coding/pack.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrEventRepository } from '../../../../src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrSweepRepository } from '../../../../src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingTodoPrRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createPackPreferenceOperations } from '../../../../src/lib/neo/preference-operations.ts';
import { getNeoPackPreference } from '../../../../src/lib/neo/preferences.ts';
import type { NeoSessionFacts } from '../../../../src/lib/neo/pack-contract.ts';

const opened = (repo: string): NeoSessionFacts => ({
  ref: { adapter: 'codex-desktop', id: 'foreign-thread' },
  status: 'done',
  lastActivityAt: 1,
  remotes: [`https://github.com/${repo}.git`],
  branches: ['work'],
  openedPrs: [`https://github.com/${repo}/pull/1`],
  linkedPrs: [{ url: `https://github.com/${repo}/pull/1`, own: true }],
});
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup(legacy = false) {
  const db = new Database(':memory:');
  databases.push(db);
  runMigrations(db, () => {});
  createTables(db);
  if (legacy) createCodingPackTables(db);
  const reads: string[] = [],
    notices: string[] = [];
  const ledger = new CodingPrLedgerRepository(db);
  const pack = createCodingPack({
    database: () => db,
    readPrs: async () => [],
    todoPrs: new CodingTodoPrRepository(db),
    prLedger: ledger,
    prEvents: new CodingPrEventRepository(db),
    prSweep: new CodingPrSweepRepository(db),
    projectRepos: () => ['foreign/repo'],
    readClaudeOwners: async () => [opened('foreign/repo')],
    readLedgerRepo: async (repo) => {
      reads.push(repo);
      return {
        data: {
          rateLimit: { remaining: 4000 },
          repository: {
            nameWithOwner: repo,
            open: { pageInfo: { hasNextPage: false }, nodes: [] },
            done: { nodes: [] },
          },
        },
      };
    },
    prSweepDeps: {
      tell: async (_ref, _key, text) => {
        notices.push(text);
        return true;
      },
      wake: async (_key, text) => {
        notices.push(text);
        return true;
      },
    },
  });
  pack.todos!.schema(db);
  const setting = () =>
    getNeoPackPreference(db, 'coding', { kind: 'global', key: '' }, 'watchedRepos')?.value;
  const save = async (value: unknown, scope = { kind: 'global' as const, key: '' }) =>
    createPackPreferenceOperations(db, () => [pack])[0].execute(
      { pack: 'coding', scope, key: 'watchedRepos', value },
      { source: 'rpc', role: 'human' }
    );
  return { db, ledger, pack, reads, notices, setting, save };
}
describe('Coding watched repositories', () => {
  test('a fresh instance ignores machine sessions and project repos until explicitly added', async () => {
    const f = setup();
    await f.pack.observeSessions!([opened('foreign/repo')], 100);
    await f.pack.sweep!(100);
    expect(f.reads).toEqual([]);
    expect(f.setting()).toEqual([]);
    expect(f.db.prepare('SELECT ref FROM pack_coding_session_facts').all()).toEqual([]);
    expect(f.notices).toEqual([]);
    expect(await f.save(['chosen/repo'])).toEqual({ ok: true });
    await f.pack.observeSessions!([opened('foreign/repo'), opened('chosen/repo')], 101);
    await f.pack.sweep!(101);
    expect(f.reads).toEqual(['chosen/repo']);
    const facts = f.db.prepare('SELECT repos, opened FROM pack_coding_session_facts').all();
    expect(facts).toEqual([
      { repos: '["chosen/repo"]', opened: '["https://github.com/chosen/repo/pull/1"]' },
    ]);
  });
  test('legacy watches seed once and an explicitly empty list survives schema initialization', async () => {
    const f = setup(true);
    expect(f.setting()).toEqual(['foreign/repo']);
    await f.pack.sweep!(100);
    expect(f.reads).toEqual(['foreign/repo']);
    expect(await f.save([])).toEqual({ ok: true });
    f.pack.todos!.schema(f.db);
    expect(f.setting()).toEqual([]);
    await f.pack.sweep!(101);
    expect(f.reads).toEqual(['foreign/repo']);
  });
  test('invalid repository names and non-global lists are refused without changing the watch list', async () => {
    const f = setup();
    for (const value of [
      ['*/*'],
      ['https://github.com/chosen/repo'],
      ['chosen/repo/extra'],
      ['../repo'],
    ]) {
      expect(await f.save(value)).toMatchObject({ ok: false });
    }
    expect(f.setting()).toEqual([]);
  });
});
