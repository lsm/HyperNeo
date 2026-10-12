import type { NeoWorkWake } from '@hyperneo/shared/types/neo-snapshot';
import type { Database } from '../sqlite-compat.ts';

const columns = `work_id AS workId, wakes, note, progress, stalled, woke_at AS wokeAt,
  continued_wake AS continuedWake`;

export class NeoWorkWakeRepository {
  private present: boolean | null = null;

  constructor(private readonly db: Database) {}

  private ready(): boolean {
    this.present ??= !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_work_wakes' AND type = 'table'")
      .get();
    return this.present;
  }

  get(workId: string): NeoWorkWake | null {
    if (!this.ready()) return null;
    return (
      (this.db
        .prepare(`SELECT ${columns} FROM neo_work_wakes WHERE work_id = ?`)
        .get(workId) as NeoWorkWake | null) ?? null
    );
  }

  recordWake(workId: string, note: string, progress: string, at: number): NeoWorkWake | null {
    if (!this.ready()) return null;
    this.db
      .prepare(
        `INSERT INTO neo_work_wakes(work_id, wakes, note, progress, stalled, woke_at)
           VALUES (?, 1, ?, ?, 0, ?)
           ON CONFLICT(work_id) DO UPDATE SET
             wakes = CASE WHEN note IS excluded.note THEN wakes ELSE wakes + 1 END,
             stalled = CASE WHEN note IS excluded.note THEN stalled
               WHEN progress IS excluded.progress THEN stalled + 1 ELSE 0 END,
             woke_at = CASE WHEN note IS excluded.note THEN woke_at ELSE excluded.woke_at END,
             progress = excluded.progress, note = excluded.note`
      )
      .run(workId, note, progress, at);
    return this.get(workId);
  }

  resetStall(workId: string, progress: string): void {
    if (!this.ready()) return;
    this.db
      .prepare('UPDATE neo_work_wakes SET stalled = 0, progress = ? WHERE work_id = ?')
      .run(progress, workId);
  }

  recordContinue(workId: string, progress: string, human: boolean): NeoWorkWake | null {
    if (!this.ready()) return null;
    const reset = human ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO neo_work_wakes(work_id, wakes, progress, stalled, continued_wake)
           VALUES (?, 0, ?, 0, 0)
           ON CONFLICT(work_id) DO UPDATE SET continued_wake = wakes,
             stalled = CASE WHEN ? THEN 0 ELSE stalled END,
             progress = CASE WHEN ? THEN excluded.progress ELSE progress END`
      )
      .run(workId, progress, reset, reset);
    return this.get(workId);
  }
}
