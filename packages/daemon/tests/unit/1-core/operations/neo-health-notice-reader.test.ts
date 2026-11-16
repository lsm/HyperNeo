import { describe, expect, spyOn, test } from 'bun:test';
import type { NeoAttentionEvent } from '../../../../src/lib/neo/attention/decide.ts';
import { deliverCodingHealth } from '../../../../src/lib/neo/packs/coding/health-delivery.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { initializeCodingWatches } from '../../../../src/lib/neo/packs/coding/watched-repos.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

const MIN = 60_000;
const NOW = 30 * MIN;

function databases() {
  const main = new Database(':memory:'),
    writer = new Database(':memory:');
  for (const db of [main, writer]) {
    createTables(db);
    runMigrations(db, () => {});
    createCodingPackTables(db, 0);
  }
  const gateway = new DbGateway(':memory:', writer);
  bindGateway(main, gateway);
  const prepared: string[] = [];
  const prepare = main.prepare.bind(main);
  spyOn(main, 'prepare').mockImplementation(((sql: string) => {
    if (/pack_coding_|neo_pack_preferences/.test(sql)) throw new Error('Health SQL on main');
    return prepare(sql);
  }) as typeof main.prepare);
  const writerPrepare = writer.prepare.bind(writer);
  spyOn(writer, 'prepare').mockImplementation(((sql: string) => {
    prepared.push(sql);
    return writerPrepare(sql);
  }) as typeof writer.prepare);
  return {
    main,
    writer,
    prepared,
    close: async () => {
      await gateway.close();
      main.close();
      writer.close();
    },
  };
}

const stall = (ledger: CodingPrLedgerRepository, repo: string) => {
  for (const at of [1, 2, 3]) ledger.recordHealth(repo, { at, outcome: 'failed' });
};

describe('GitHub health delivery reads', () => {
  test('a renamed repository is raised once under its canonical name, with no health SQL on the caller', async () => {
    const { main, writer, close } = databases();
    const ledger = new CodingPrLedgerRepository(writer);
    initializeCodingWatches(writer, ['synthetic/old']);
    ledger.recordAlias('synthetic/old', 'synthetic/new');
    stall(ledger, 'synthetic/old');
    ledger.replace(
      'synthetic/new',
      [
        {
          repo: 'synthetic/new',
          number: 1,
          title: 'Ready after CI',
          branch: 'topic',
          head: 'approved-head',
          state: 'approved_pending',
          closedAt: null,
        },
      ],
      0
    );
    const raised: NeoAttentionEvent[] = [];
    try {
      await deliverCodingHealth(
        new CodingPrLedgerRepository(main),
        ['synthetic/old', 'SYNTHETIC/NEW'],
        async (event) => {
          raised.push(event);
        },
        NOW
      );
      expect(raised).toEqual([
        {
          kind: 'coding.github_health',
          subject: { type: 'repo', id: 'synthetic/new' },
          since: 3,
          facts: {
            text: 'GitHub coverage stalled for synthetic/new. Incident github-health:synthetic/new:1.',
          },
        },
        {
          kind: 'coding.github_health',
          subject: { type: 'pr_head', id: 'synthetic/new#1@approved-head' },
          since: 0,
          facts: {
            text: `GitHub readiness observation stalled for synthetic/new#1 (approved_pending, head approve) since ${new Date(0).toISOString()}. Current CI is unverified; check polling before acting.`,
          },
        },
      ]);
    } finally {
      await close();
    }
  });

  test('a refused subject does not stop the next repository, and is raised again next time', async () => {
    const { main, writer, close } = databases();
    const ledger = new CodingPrLedgerRepository(writer);
    for (const repo of ['synthetic/a', 'synthetic/b']) stall(ledger, repo);
    const attempts: string[] = [];
    let refuse = true;
    const attend = async (event: NeoAttentionEvent) => {
      attempts.push(event.subject.id);
      if (refuse && event.subject.id === 'synthetic/a') throw new Error('synthetic refusal');
    };
    try {
      const repos = ['synthetic/a', 'synthetic/b'];
      await deliverCodingHealth(new CodingPrLedgerRepository(main), repos, attend, NOW);
      refuse = false;
      await deliverCodingHealth(new CodingPrLedgerRepository(main), repos, attend, NOW);
      expect(attempts).toEqual(['synthetic/a', 'synthetic/b', 'synthetic/a', 'synthetic/b']);
    } finally {
      await close();
    }
  });

  test('polling-only and empty health never read the PR ledger', async () => {
    const { main, writer, prepared, close } = databases();
    stall(new CodingPrLedgerRepository(writer), 'polling:fixture/stale');
    const raised: string[] = [];
    try {
      prepared.length = 0;
      for (const repos of [['polling:fixture/stale'], [], ['synthetic/never-read']])
        await deliverCodingHealth(
          new CodingPrLedgerRepository(main),
          repos,
          async (event) => {
            raised.push(event.subject.id);
          },
          NOW
        );
      expect(raised).toEqual(['polling:fixture/stale']);
      expect(prepared.filter((sql) => sql.includes('pack_coding_pr_ledger'))).toEqual([]);
    } finally {
      await close();
    }
  });
});
