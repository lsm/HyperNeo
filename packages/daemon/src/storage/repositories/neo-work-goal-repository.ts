import type { NeoWorkGoal } from '@hyperneo/shared/types/neo-snapshot';
import type { Database } from '../sqlite-compat.ts';

export class NeoWorkGoalRepository {
  constructor(private readonly db: Database) {}

  private hasTable(): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_work_goals' AND type = 'table'")
      .get();
  }

  record(workId: string, goal: string | null, doneWhen: string | null): void {
    if ((!goal && !doneWhen) || !this.hasTable()) return;
    this.db
      .prepare(
        'INSERT INTO neo_work_goals(work_id, goal, done_when) VALUES (?, ?, ?) ON CONFLICT(work_id) DO NOTHING'
      )
      .run(workId, goal, doneWhen);
  }

  get(workId: string): NeoWorkGoal | null {
    if (!this.hasTable()) return null;
    return (
      (this.db
        .prepare(
          'SELECT work_id AS workId, goal, done_when AS doneWhen FROM neo_work_goals WHERE work_id = ?'
        )
        .get(workId) as NeoWorkGoal | null) ?? null
    );
  }

  list(workIds: readonly string[]): NeoWorkGoal[] {
    return workIds.flatMap((id) => {
      const goal = this.get(id);
      return goal ? [goal] : [];
    });
  }
}
