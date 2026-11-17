import type { GoalJournalEntry, SessionGoal } from '@hyperneo/shared/types/session-goal';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';

class SessionGoalReviewReader {
  constructor(private readonly db: Database) {}

  scheduled(): SessionGoal[] {
    const rows = this.db
      .prepare(`SELECT id, owner_session_id AS ownerSessionId, title, description,
      status, type, priority, metrics, done_test AS doneTest, summary, works_note AS worksNote,
      progress, next_steps AS nextSteps, mandate_ref AS mandateRef, mandate_rev AS mandateRev,
      daily_run_limit AS dailyRunLimit, created_at AS createdAt, updated_at AS updatedAt,
      completed_at AS completedAt, revision FROM neo_goals
      WHERE owner_session_id IS NOT NULL AND status IN ('active', 'paused')`)
      .all() as (Omit<SessionGoal, 'metrics' | 'nextSteps'> & {
      metrics: string;
      nextSteps: string;
    })[];
    return rows.map((row) => ({
      ...row,
      metrics: JSON.parse(row.metrics),
      nextSteps: JSON.parse(row.nextSteps),
    }));
  }

  journal(goalId: string): GoalJournalEntry[] {
    const rows = this.db
      .prepare(`SELECT id, goal_id AS goalId, run_id AS runId, session_id AS sessionId,
      done, effect, evidence, worked, failed, created_at AS createdAt FROM goal_journal
      WHERE goal_id = ? AND rowid > COALESCE(
        (SELECT MAX(rowid) FROM goal_journal WHERE goal_id = ? AND run_id LIKE 'goal-review:%'), 0)
      ORDER BY rowid`)
      .all(goalId, goalId) as (Omit<GoalJournalEntry, 'evidence'> & { evidence: string })[];
    return rows.map((row) => ({ ...row, evidence: JSON.parse(row.evidence) }));
  }
}

export const sessionGoalReviewReads = defineRepositoryOp(
  'sessionGoal.review.read',
  'read',
  SessionGoalReviewReader,
  ['scheduled', 'journal'] as const
);
