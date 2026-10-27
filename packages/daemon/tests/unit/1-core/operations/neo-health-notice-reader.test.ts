import { expect, test } from 'bun:test';
import { deliverCodingHealth } from '../../../../src/lib/neo/packs/coding/health-delivery.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

test('a durable coverage notice is offered through a query-only gateway', async () => {
  const db = new Database(':memory:');
  createTables(db);
  runMigrations(db, () => {});
  createCodingPackTables(db);
  const ledger = new CodingPrLedgerRepository(db);
  const repo = 'synthetic/health-reader';
  for (const at of [1, 2, 3]) ledger.recordHealth(repo, { at, outcome: 'failed' });
  const expected = ledger.health.read(repo)!.notices![0];
  const offered: { key: string; text: string }[] = [];
  const gateway = new DbGateway(':memory:', db);
  bindGateway(db, gateway);
  db.exec('PRAGMA query_only=ON');
  try {
    await deliverCodingHealth(
      ledger,
      [repo],
      async (key, text) => {
        offered.push({ key, text });
        return false;
      },
      4
    );
    expect(offered).toEqual([{ key: expected.key, text: expected.text }]);
    expect(ledger.health.read(repo)!.notices![0].acceptedAt).toBeNull();
  } finally {
    await gateway.close();
    db.close();
  }
});
