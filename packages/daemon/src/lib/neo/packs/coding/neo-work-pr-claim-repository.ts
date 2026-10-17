import type { Database } from '../../../../storage/sqlite-compat.ts';
import type { NeoPrClaimRow, NeoPrClaimState } from './card-pr-claims.ts';

export class NeoWorkPrClaimRepository {
  constructor(private readonly db: Database) {}

  forUrls(urls: readonly string[]): NeoPrClaimRow[] {
    if (urls.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT c.work_id AS workId, c.url_key AS urlKey, c.claim, c.claimed_at AS claimedAt,
            w.created_at AS cardCreatedAt, c.score, c.scoped
           FROM neo_work_pr_claims c JOIN neo_work w ON w.id = c.work_id
          WHERE c.url_key IN (SELECT value FROM json_each(?))`
      )
      .all(JSON.stringify(urls.map((url) => url.toLowerCase()))) as (Omit<
      NeoPrClaimRow,
      'scoped'
    > & { scoped: number })[];
    return rows.map(({ scoped, ...row }) => ({ ...row, ...(scoped ? { scoped: true } : {}) }));
  }

  cardsToReclaim(): string[] {
    return (
      this.db
        .prepare(
          `SELECT w.id AS workId FROM neo_work w
            WHERE (NOT EXISTS (SELECT 1 FROM neo_work_pr_claims c WHERE c.work_id = w.id)
                AND (w.report LIKE '%/pull/%' OR w.report GLOB '*#[0-9]*'
                  OR EXISTS (SELECT 1 FROM neo_work_prs p
                              WHERE p.work_id = w.id AND p.prs_json <> '[]')))
               OR EXISTS (SELECT 1 FROM neo_work_pr_claims c
                           WHERE c.work_id = w.id AND c.claim <> 'named' AND c.scoped = 0)`
        )
        .all() as { workId: string }[]
    ).map((row) => row.workId);
  }

  rejectedUrls(workId: string): { url: string }[] {
    return this.db
      .prepare(
        `SELECT url_key AS url FROM neo_work_pr_claims
          WHERE work_id = ? AND claim = 'rejected' AND scoped = 0`
      )
      .all(workId) as { url: string }[];
  }

  markReclaimed(workId: string, rejected: readonly { url: string }[]): void {
    if (!rejected.length) return;
    this.db
      .prepare(
        `UPDATE neo_work_pr_claims SET scoped = 1
          WHERE work_id = ? AND claim = 'rejected' AND scoped = 0
            AND url_key IN (SELECT value FROM json_each(?))`
      )
      .run(workId, JSON.stringify(rejected.map((item) => item.url.toLowerCase())));
  }

  drop(workId: string, urlKey: string, claim: NeoPrClaimState): void {
    this.db
      .prepare('DELETE FROM neo_work_pr_claims WHERE work_id = ? AND url_key = ? AND claim = ?')
      .run(workId, urlKey, claim);
  }

  replace(
    workId: string,
    claims: readonly {
      url: string;
      claim: NeoPrClaimState;
      claimedAt: number;
      score?: number | null;
      scoped?: boolean;
    }[]
  ): void {
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
        `INSERT INTO neo_work_pr_claims(work_id, url_key, claim, claimed_at, score, scoped)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(work_id, url_key) DO UPDATE SET claim = excluded.claim,
             score = COALESCE(excluded.score, neo_work_pr_claims.score),
             scoped = excluded.scoped`
      );
      claims.forEach((claim, index) =>
        upsert.run(
          workId,
          keys[index],
          claim.claim === 'opened' ? 'branch' : claim.claim,
          claim.claimedAt,
          claim.score ?? null,
          claim.scoped ? 1 : 0
        )
      );
    })();
  }
}
