import { expect, test } from 'bun:test';
import type { NeoAttentionEvent } from '../../../../src/lib/neo/attention/decide.ts';
import { deliverCodingHealth } from '../../../../src/lib/neo/packs/coding/health-delivery.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

test('a stalled repository is raised through a query-only gateway', async () => {
  const db = new Database(':memory:');
  createTables(db);
  runMigrations(db, () => {});
  createCodingPackTables(db);
  const ledger = new CodingPrLedgerRepository(db);
  const repo = 'synthetic/health-reader';
  for (const at of [1, 2, 3]) ledger.recordHealth(repo, { at, outcome: 'failed' });
  const raised: NeoAttentionEvent[] = [];
  const gateway = new DbGateway(':memory:', db);
  bindGateway(db, gateway);
  db.exec('PRAGMA query_only=ON');
  try {
    await deliverCodingHealth(
      ledger,
      [repo],
      async (event) => {
        raised.push(event);
      },
      4
    );
    expect(raised).toEqual([
      {
        kind: 'coding.github_health',
        subject: { type: 'repo', id: repo },
        since: 3,
        facts: {
          text: `GitHub coverage stalled for ${repo}. Incident github-health:${repo}:1.`,
        },
      },
    ]);
  } finally {
    await gateway.close();
    db.close();
  }
});
