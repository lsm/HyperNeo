import type { Database } from '../../../../storage/sqlite-compat.ts';
import type { NeoPrClaimRow, NeoPrClaimState } from './card-pr-claims.ts';

export class NeoWorkPrClaimRepository {
  constructor(private readonly db: Database) {}

  private hasTable(): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_work_pr_claims' AND type = 'table'")
      .get();
  }

  forUrls(urls: readonly string[]): NeoPrClaimRow[] {
    if (!this.hasTable() || urls.length === 0) return [];
    return this.db
      .prepare(
        `SELECT c.work_id AS workId, c.url_key AS urlKey, c.claim, c.claimed_at AS claimedAt,
            w.created_at AS cardCreatedAt
           FROM neo_work_pr_claims c JOIN neo_work w ON w.id = c.work_id
          WHERE c.url_key IN (SELECT value FROM json_each(?))`
      )
      .all(JSON.stringify(urls.map((url) => url.toLowerCase()))) as NeoPrClaimRow[];
  }

  replace(
    workId: string,
    claims: readonly { url: string; claim: NeoPrClaimState; claimedAt: number }[]
  ): void {
    if (!this.hasTable()) return;
    const keys = claims.map((claim) => claim.url.toLowerCase());
    this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM neo_work_pr_claims
            WHERE work_id = ? AND claim <> 'rejected'
              AND url_key NOT IN (SELECT value FROM json_each(?))`
        )
        .run(workId, JSON.stringify(keys));
      const upsert = this.db.prepare(
        `INSERT INTO neo_work_pr_claims(work_id, url_key, claim, claimed_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(work_id, url_key) DO UPDATE SET claim = excluded.claim`
      );
      claims.forEach((claim, index) =>
        upsert.run(workId, keys[index], claim.claim, claim.claimedAt)
      );
    })();
  }
}
