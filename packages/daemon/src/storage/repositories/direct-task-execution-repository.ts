import type { Database } from '../sqlite-compat.ts';

export interface DirectTaskAttempt {
  id: string;
  taskId: string;
  generation: number;
  sessionId: string;
  phase: 'reserved' | 'running' | 'stopped';
  outcome: string | null;
  createdAt: number;
  updatedAt: number;
}

const columns = `id, task_id AS taskId, generation, session_id AS sessionId,
  phase, outcome, created_at AS createdAt, updated_at AS updatedAt`;

export class DirectTaskExecutionRepository {
  constructor(private db: Database) {}

  isSelected(taskId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM direct_task_execution_selection WHERE task_id = ?')
      .get(taskId);
  }

  listSelectedTaskIds(spaceId: string): string[] {
    const rows = this.db
      .prepare(`SELECT s.task_id FROM direct_task_execution_selection s
      JOIN space_tasks t ON t.id = s.task_id WHERE t.space_id = ?`)
      .all(spaceId) as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  }

  select(taskId: string): boolean {
    this.db
      .prepare(`INSERT INTO direct_task_execution_selection(task_id)
      SELECT id FROM space_tasks WHERE id = ? AND space_id IS NOT NULL
        AND workflow_run_id IS NULL AND status IN ('draft', 'open') AND archived_at IS NULL
      ON CONFLICT(task_id) DO NOTHING`)
      .run(taskId);
    return this.isSelected(taskId);
  }

  get(id: string): DirectTaskAttempt | null {
    return this.db
      .prepare(`SELECT ${columns} FROM direct_task_execution_attempts WHERE id = ?`)
      .get(id) as DirectTaskAttempt | null;
  }

  getActive(taskId: string): DirectTaskAttempt | null {
    return this.db
      .prepare(`SELECT ${columns} FROM direct_task_execution_attempts
      WHERE task_id = ? AND phase <> 'stopped'`)
      .get(taskId) as DirectTaskAttempt | null;
  }

  claim(taskId: string, attemptId: string, sessionId: string): DirectTaskAttempt | null {
    this.db
      .prepare(`INSERT INTO direct_task_execution_attempts
      (id, task_id, generation, session_id, phase, created_at, updated_at)
      SELECT ?, t.id, COALESCE((SELECT MAX(generation) FROM direct_task_execution_attempts
        WHERE task_id = t.id), 0) + 1, ?, 'reserved', ?, ?
      FROM space_tasks t JOIN direct_task_execution_selection s ON s.task_id = t.id
      WHERE t.id = ? AND t.space_id IS NOT NULL AND t.workflow_run_id IS NULL
        AND t.status = 'open' AND t.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM direct_task_execution_attempts
          WHERE task_id = t.id AND phase <> 'stopped')
      ON CONFLICT DO NOTHING`)
      .run(attemptId, sessionId, Date.now(), Date.now(), taskId);
    const attempt = this.get(attemptId);
    return attempt?.taskId === taskId &&
      attempt.sessionId === sessionId &&
      attempt.phase !== 'stopped'
      ? attempt
      : null;
  }

  requestStop(id: string, sessionId: string, outcome: string): DirectTaskAttempt | null {
    this.db
      .prepare(`INSERT INTO direct_task_stop_requests(attempt_id, session_id, outcome, requested_at)
      SELECT id, session_id, ?, ? FROM direct_task_execution_attempts
      WHERE id = ? AND session_id = ? AND phase <> 'stopped'
      ON CONFLICT(attempt_id) DO NOTHING`)
      .run(outcome, Date.now(), id, sessionId);
    return this.isStopRequested(id, sessionId) ? this.get(id) : null;
  }

  isStopRequested(id: string, sessionId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM direct_task_stop_requests WHERE attempt_id = ? AND session_id = ?')
      .get(id, sessionId);
  }

  finishRequestedStop(id: string, sessionId: string): DirectTaskAttempt | null {
    return this.db
      .prepare(`UPDATE direct_task_execution_attempts
      SET phase = 'stopped', outcome = (SELECT outcome FROM direct_task_stop_requests WHERE attempt_id = ?), updated_at = ?
      WHERE id = ? AND session_id = ? AND EXISTS (SELECT 1 FROM direct_task_stop_requests WHERE attempt_id = ? AND session_id = ?)
      RETURNING ${columns}`)
      .get(id, Date.now(), id, sessionId, id, sessionId) as DirectTaskAttempt | null;
  }

  activate(id: string, sessionId: string): DirectTaskAttempt | null {
    return this.db
      .prepare(`UPDATE direct_task_execution_attempts SET phase = 'running', updated_at = ?
      WHERE id = ? AND session_id = ? AND phase = 'reserved' AND NOT EXISTS (SELECT 1 FROM direct_task_stop_requests WHERE attempt_id = ?) RETURNING ${columns}`)
      .get(Date.now(), id, sessionId, id) as DirectTaskAttempt | null;
  }

  stop(id: string, sessionId: string, outcome: string): DirectTaskAttempt | null {
    return this.db
      .prepare(`UPDATE direct_task_execution_attempts
      SET phase = 'stopped', outcome = ?, updated_at = ?
      WHERE id = ? AND session_id = ? AND phase <> 'stopped' RETURNING ${columns}`)
      .get(outcome, Date.now(), id, sessionId) as DirectTaskAttempt | null;
  }
}
