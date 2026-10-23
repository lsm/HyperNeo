import { createHash } from 'node:crypto';
import { SessionScheduleRepository } from '../repositories/session-schedule-repository.ts';
import type { Database } from '../sqlite-compat.ts';

export function runMigration448(db: Database): void {
  const repo = new SessionScheduleRepository(db);
  const update = db.prepare(
    'UPDATE session_schedules SET due_count = 0, facts_digest = ? WHERE id = ?'
  );
  for (const schedule of repo.list()) {
    const progress = repo.progressKey(schedule);
    const digest =
      schedule.factsDigest !== null && progress !== null
        ? createHash('sha256')
            .update(JSON.stringify([schedule.factsDigest, progress]))
            .digest('hex')
        : schedule.factsDigest;
    update.run(digest, schedule.id);
  }
}
