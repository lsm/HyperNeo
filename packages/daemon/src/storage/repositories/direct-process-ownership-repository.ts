import { randomUUID } from 'node:crypto';
import type { Database } from '../sqlite-compat.ts';

export interface DirectProcessAttempt {
  attemptId: string;
  sessionId: string;
  generation: number;
}
export interface DirectProcessIdentity extends DirectProcessAttempt {
  id: string;
  token: string;
}
export interface DirectProcessLaunch extends DirectProcessIdentity {
  state: 'reserved' | 'authorized' | 'exited' | 'never_started';
  createdAt: number;
  updatedAt: number;
}
const columns = `id, token, attempt_id AS attemptId, session_id AS sessionId,
  generation, state, created_at AS createdAt, updated_at AS updatedAt`;
const active = `EXISTS (SELECT 1 FROM direct_task_execution_attempts a
  WHERE a.id = ? AND a.session_id = ? AND a.generation = ? AND a.phase = ?
  AND NOT EXISTS (SELECT 1 FROM direct_task_stop_requests s WHERE s.attempt_id = a.id))`;

export class DirectProcessOwnershipRepository {
  constructor(private db: Database) {}

  manageAttempt(attempt: DirectProcessAttempt): boolean {
    this.db
      .prepare(`INSERT INTO direct_task_process_coverage
      (attempt_id, session_id, generation, created_at)
      SELECT ?, ?, ?, ? WHERE ${active} ON CONFLICT DO NOTHING`)
      .run(
        attempt.attemptId,
        attempt.sessionId,
        attempt.generation,
        Date.now(),
        attempt.attemptId,
        attempt.sessionId,
        attempt.generation,
        'reserved'
      );
    return this.hasCoverage(attempt);
  }

  hasCoverage(attempt: DirectProcessAttempt): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM direct_task_process_coverage
      WHERE attempt_id = ? AND session_id = ? AND generation = ?`)
      .get(attempt.attemptId, attempt.sessionId, attempt.generation);
  }

  reserveLaunch(attempt: DirectProcessAttempt): DirectProcessLaunch | null {
    const id = randomUUID();
    const token = randomUUID();
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO direct_task_process_launches
      (id, token, attempt_id, session_id, generation, state, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, 'reserved', ?, ? WHERE ${active}
        AND EXISTS (SELECT 1 FROM direct_task_process_coverage
          WHERE attempt_id = ? AND session_id = ? AND generation = ?)`)
      .run(
        id,
        token,
        attempt.attemptId,
        attempt.sessionId,
        attempt.generation,
        now,
        now,
        attempt.attemptId,
        attempt.sessionId,
        attempt.generation,
        'running',
        attempt.attemptId,
        attempt.sessionId,
        attempt.generation
      );
    return this.get({ ...attempt, id, token });
  }

  get(identity: DirectProcessIdentity): DirectProcessLaunch | null {
    return this.db
      .prepare(`SELECT ${columns} FROM direct_task_process_launches
      WHERE id = ? AND token = ? AND attempt_id = ? AND session_id = ? AND generation = ?`)
      .get(
        identity.id,
        identity.token,
        identity.attemptId,
        identity.sessionId,
        identity.generation
      ) as DirectProcessLaunch | null;
  }

  listLaunches(attempt: DirectProcessAttempt): DirectProcessLaunch[] {
    return this.db
      .prepare(`SELECT ${columns} FROM direct_task_process_launches
      WHERE attempt_id = ? AND session_id = ? AND generation = ? ORDER BY created_at, id`)
      .all(attempt.attemptId, attempt.sessionId, attempt.generation) as DirectProcessLaunch[];
  }

  authorizeLaunch(identity: DirectProcessIdentity): boolean {
    return (
      this.db
        .prepare(`UPDATE direct_task_process_launches SET state = 'authorized', updated_at = ?
      WHERE id = ? AND token = ? AND attempt_id = ? AND session_id = ? AND generation = ?
        AND state = 'reserved' AND ${active}`)
        .run(
          Date.now(),
          identity.id,
          identity.token,
          identity.attemptId,
          identity.sessionId,
          identity.generation,
          identity.attemptId,
          identity.sessionId,
          identity.generation,
          'running'
        ).changes === 1
    );
  }

  recordGuardianTerminal(
    identity: DirectProcessIdentity,
    state: 'exited' | 'never_started'
  ): boolean {
    this.db
      .prepare(`UPDATE direct_task_process_launches SET state = ?, updated_at = ?
      WHERE id = ? AND token = ? AND attempt_id = ? AND session_id = ? AND generation = ?
        AND (state = 'authorized' OR (state = 'reserved' AND ? = 'never_started'))`)
      .run(
        state,
        Date.now(),
        identity.id,
        identity.token,
        identity.attemptId,
        identity.sessionId,
        identity.generation,
        state
      );
    return this.get(identity)?.state === state;
  }
}
