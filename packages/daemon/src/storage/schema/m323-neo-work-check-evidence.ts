import type { Database } from '../sqlite-compat.ts';

type Pr = { url: string; state: string; checks: string; review: string; blockers?: string[] };
type Told = { workId: string; signature: string; reminded: string | null; prsJson: string };

const hasTable = (db: Database, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type = 'table'").get(name);

const legacySignature = (prs: readonly Pr[]) =>
  JSON.stringify(
    prs.map(({ url, state, checks, review, blockers }) => [
      url,
      state,
      checks,
      review,
      ...(blockers?.length ? [blockers] : []),
    ])
  );

const evidenceState = (pr: Pr) =>
  pr.state === 'MERGED'
    ? 'done'
    : pr.state === 'CLOSED'
      ? 'failed'
      : pr.checks === 'pending'
        ? 'waiting'
        : pr.checks === 'failing' || pr.review === 'changes_requested'
          ? 'failed'
          : pr.review === 'approved'
            ? 'ready'
            : 'pending';

const evidenceSignature = (prs: readonly Pr[]) =>
  JSON.stringify(
    [...prs]
      .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
      .map((pr) => [
        pr.url,
        evidenceState(pr),
        `${pr.state.toLowerCase()}, checks ${pr.checks}, review ${pr.review}`,
        [...(pr.blockers ?? [])].sort(),
      ])
  );

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
      const prs = JSON.parse(row.prsJson) as Pr[];
      if (row.signature !== legacySignature(prs)) continue;
      const signature = evidenceSignature(prs);
      update.run(signature, row.reminded === row.signature ? signature : row.reminded, row.workId);
    }
  })();
}
