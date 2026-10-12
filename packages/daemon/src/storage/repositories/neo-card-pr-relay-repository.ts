import type { Database } from '../sqlite-compat.ts';

export class NeoCardPrRelayRepository {
  constructor(private readonly db: Database) {}

  get(workId: string): string | null {
    const row = this.db
      .prepare('SELECT signature FROM neo_card_pr_relays WHERE work_id = ?')
      .get(workId) as { signature: string } | undefined;
    return row?.signature ?? null;
  }

  markTold(workId: string, signature: string, at: number): void {
    this.db
      .prepare(
        `INSERT INTO neo_card_pr_relays(work_id, signature, told_at) VALUES (?, ?, ?)
         ON CONFLICT(work_id) DO UPDATE SET signature = excluded.signature, told_at = excluded.told_at`
      )
      .run(workId, signature, at);
  }

  clear(workId: string): void {
    this.db.prepare('DELETE FROM neo_card_pr_relays WHERE work_id = ?').run(workId);
  }
}
