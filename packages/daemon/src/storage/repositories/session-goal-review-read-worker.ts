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

  journal(goalId: string): { entries: GoalJournalEntry[]; earlier: number; cursor: string } {
    return this.db.transaction(() => {
      const review = this.db
        .prepare(`SELECT rowid AS seq, run_id AS runId FROM goal_journal
        WHERE goal_id = ? AND run_id LIKE 'goal-review:%' ORDER BY rowid DESC LIMIT 1`)
        .get(goalId) as { seq: number; runId: string } | null;
      const match = review?.runId.match(/^goal-review:[^:]+:\d+:([a-f0-9-]{36}|none)$/i);
      const previous = match?.[1] ?? null;
      const prior =
        previous && previous !== 'none'
          ? (this.db
              .prepare('SELECT rowid AS seq FROM goal_journal WHERE goal_id = ? AND id = ?')
              .get(goalId, previous) as { seq: number } | null)
          : null;
      const after = match ? (prior?.seq ?? 0) : (review?.seq ?? 0);
      const count = this.db
        .prepare(`SELECT COUNT(*) AS count FROM goal_journal WHERE goal_id = ? AND rowid > ?
        AND (run_id IS NULL OR run_id NOT LIKE 'goal-review:%')`)
        .get(goalId, after) as { count: number };
      const rows = this.db
        .prepare(`SELECT id, goal_id AS goalId, run_id AS runId, session_id AS sessionId,
        done, effect, evidence, worked, failed, created_at AS createdAt FROM goal_journal
        WHERE goal_id = ? AND rowid > ? AND (run_id IS NULL OR run_id NOT LIKE 'goal-review:%')
        ORDER BY rowid DESC LIMIT 20`)
        .all(goalId, after) as (Omit<GoalJournalEntry, 'evidence'> & { evidence: string })[];
      const entries = rows.reverse().map((row) => ({ ...row, evidence: JSON.parse(row.evidence) }));
      return {
        entries,
        earlier: count.count - entries.length,
        cursor: entries.at(-1)?.id ?? previous ?? 'none',
      };
    })();
  }
}

export const sessionGoalReviewReads = defineRepositoryOp(
  'sessionGoal.review.read',
  'read',
  SessionGoalReviewReader,
  ['scheduled', 'journal'] as const
);
