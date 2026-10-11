import type { Database } from '../sqlite-compat.ts';

export interface NeoAskCheckRow {
  askId: string;
  signature: string;
  toldAt: number;
}

export class NeoAskCheckRepository {
  constructor(private readonly db: Database) {}

  get(askId: string): NeoAskCheckRow | null {
    return (
      (this.db
        .prepare(
          'SELECT ask_id AS askId, signature, told_at AS toldAt FROM neo_ask_checks WHERE ask_id = ?'
        )
        .get(askId) as NeoAskCheckRow | undefined) ?? null
    );
  }

  markTold(askId: string, signature: string, at: number): void {
    this.db
      .prepare(
        `INSERT INTO neo_ask_checks(ask_id, signature, told_at) VALUES (?, ?, ?)
         ON CONFLICT(ask_id) DO UPDATE SET signature = excluded.signature, told_at = excluded.told_at`
      )
      .run(askId, signature, at);
  }
}
