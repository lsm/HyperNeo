import type { Database } from '../sqlite-compat.ts';

export interface NeoAskCheckRow {
  askId: string;
  signature: string;
  toldAt: number;
}

export class NeoAskCheckRepository {
  constructor(private readonly db: Database) {}

  private hasTable(): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_ask_checks' AND type = 'table'")
      .get();
  }

  get(askId: string): NeoAskCheckRow | null {
    if (!this.hasTable()) return null;
    return (
      (this.db
        .prepare(
          'SELECT ask_id AS askId, signature, told_at AS toldAt FROM neo_ask_checks WHERE ask_id = ?'
        )
        .get(askId) as NeoAskCheckRow | undefined) ?? null
    );
  }

  markTold(askId: string, signature: string, at: number): void {
    if (!this.hasTable()) return;
    this.db
      .prepare(
        `INSERT INTO neo_ask_checks(ask_id, signature, told_at) VALUES (?, ?, ?)
         ON CONFLICT(ask_id) DO UPDATE SET signature = excluded.signature, told_at = excluded.told_at`
      )
      .run(askId, signature, at);
  }
}
