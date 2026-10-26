import { defineDbOp } from '../db-gateway/db-op.ts';
import { JobQueueRepository } from './job-queue-repository.ts';
import { SessionRepository } from './session-repository.ts';

export const releaseRateLimitDeliveries = defineDbOp<{ sessionId: string }, boolean>({
  name: 'jobs.releaseRateLimitDeliveries',
  mode: 'write',
  run(db, { sessionId }) {
    const row = new SessionRepository(db).getSession(sessionId);
    if (!row) return false;
    if (
      row.processingState &&
      (JSON.parse(row.processingState) as { status?: string }).status === 'rate_limit_cooldown'
    ) {
      return false;
    }
    return new JobQueueRepository(db).rescheduleSessionDeliveries(sessionId, Date.now());
  },
});
