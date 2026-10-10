import { describe, expect, test } from 'bun:test';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { neoEvidenceSignature } from '../../../../src/lib/neo/evidence';
import {
  neoWorkPrEvidence,
  neoWorkPrSignature,
} from '../../../../src/lib/neo/packs/coding/work-prs';
import { NeoWorkCheckRepository } from '../../../../src/storage/repositories/neo-work-check-repository';
import { runMigration314 } from '../../../../src/storage/schema/m314-neo-work-prs';
import { runMigration317 } from '../../../../src/storage/schema/m317-neo-work-pr-reminders';
import { runMigration320 } from '../../../../src/storage/schema/m320-neo-work-checks';
import { runMigration323 } from '../../../../src/storage/schema/m323-neo-work-check-evidence';
import { Database } from '../../../../src/storage/sqlite-compat';

const pr: NeoWorkPr = {
  url: 'https://github.com/lsm/HyperNeo/pull/42',
  state: 'OPEN',
  checks: 'passing',
  review: 'approved',
};

describe('runMigration323', () => {
  test('moves what Neo was told to evidence signatures, and leaves stale rows unseen', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_work (id TEXT PRIMARY KEY)');
    db.exec("INSERT INTO neo_work VALUES ('w1'), ('w2'), ('w3')");
    runMigration314(db);
    runMigration317(db);
    runMigration320(db);
    const legacy = neoWorkPrSignature([pr]);
    db.prepare(
      `INSERT INTO neo_work_prs(work_id, prs_json, open, revision, read_at, read_ok_at)
         VALUES (?, ?, 1, 1, 0, 0)`
    ).run('w1', JSON.stringify([pr]));
    db.prepare(
      `INSERT INTO neo_work_prs(work_id, prs_json, open, revision, read_at, read_ok_at)
         VALUES (?, ?, 1, 2, 0, 0)`
    ).run('w2', JSON.stringify([{ ...pr, checks: 'failing' }]));
    const checks = new NeoWorkCheckRepository(db);
    checks.markTold('w1', legacy, 10, true);
    checks.markTold('w2', legacy, 20);
    checks.markTold('w3', 'no pull requests', 30);

    runMigration323(db);
    runMigration323(db);

    const evidence = neoEvidenceSignature(neoWorkPrEvidence([pr]));
    expect(['w1', 'w2', 'w3'].map((id) => checks.get(id))).toEqual([
      { workId: 'w1', signature: evidence, toldAt: 10, reminded: evidence },
      { workId: 'w2', signature: legacy, toldAt: 20, reminded: null },
      { workId: 'w3', signature: 'no pull requests', toldAt: 30, reminded: null },
    ]);
    const bare = new Database(':memory:');
    runMigration323(bare);
  });
});
