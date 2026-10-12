import type { Database } from '../../../../storage/sqlite-compat.ts';

export interface NeoCardPrSubscription {
  workId: string;
  topic: string;
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

export class NeoCardPrSubscriptionRepository {
  constructor(private readonly db: Database) {}

  subscribe(workId: string, topic: string, at: number): boolean {
    return (
      this.db
        .prepare(
          `INSERT INTO neo_card_pr_subscriptions(work_id, topic, created_at) VALUES (?, ?, ?)
           ON CONFLICT(work_id, topic) DO NOTHING`
        )
        .run(workId, topic, at).changes > 0
    );
  }

  listActive(): NeoCardPrSubscription[] {
    return this.db
      .prepare(
        `SELECT work_id AS workId, topic FROM neo_card_pr_subscriptions
          WHERE ended_at IS NULL ORDER BY created_at, rowid`
      )
      .all() as NeoCardPrSubscription[];
  }

  end(workId: string, topic: string, at: number): void {
    this.db
      .prepare(
        `UPDATE neo_card_pr_subscriptions SET ended_at = ?
          WHERE work_id = ? AND topic = ? AND ended_at IS NULL`
      )
      .run(at, workId, topic);
  }

  referencesRepo(owner: string, repo: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM neo_card_pr_subscriptions
          WHERE ended_at IS NULL AND topic LIKE ? ESCAPE '\\' LIMIT 1`
      )
      .get(`github/${escapeLike(owner)}/${escapeLike(repo)}/%`);
  }
}
