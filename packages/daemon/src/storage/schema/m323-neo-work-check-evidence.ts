import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { neoEvidenceSignature } from '../../lib/neo/evidence.ts';
import { neoWorkPrEvidence, neoWorkPrSignature } from '../../lib/neo/packs/coding/work-prs.ts';
import type { Database } from '../sqlite-compat.ts';

type Told = { workId: string; signature: string; reminded: string | null; prsJson: string };

const hasTable = (db: Database, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type = 'table'").get(name);

export function runMigration323(db: Database): void {
  if (!hasTable(db, 'neo_work_checks') || !hasTable(db, 'neo_work_prs')) return;
  const rows = db
    .prepare(`SELECT c.work_id AS workId, c.signature, c.reminded, p.prs_json AS prsJson
      FROM neo_work_checks c JOIN neo_work_prs p ON p.work_id = c.work_id`)
    .all() as Told[];
  const update = db.prepare(
    'UPDATE neo_work_checks SET signature = ?, reminded = ? WHERE work_id = ?'
  );
  db.transaction(() => {
    for (const row of rows) {
      const prs = JSON.parse(row.prsJson) as NeoWorkPr[];
      if (row.signature !== neoWorkPrSignature(prs)) continue;
      const signature = neoEvidenceSignature(neoWorkPrEvidence(prs));
      update.run(signature, row.reminded === row.signature ? signature : row.reminded, row.workId);
    }
  })();
}
