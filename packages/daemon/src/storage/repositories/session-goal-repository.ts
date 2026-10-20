import { generateUUID } from '@hyperneo/shared';
import type {
  GoalJournalDraft,
  GoalJournalEntry,
  SessionGoal,
  SessionGoalDraft,
  SessionGoalPatch,
} from '@hyperneo/shared/types/session-goal';
import type { SpaceGoalEventSource } from '@hyperneo/shared';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { Database } from '../sqlite-compat.ts';

const COLUMNS: Record<keyof SessionGoalPatch, string> = {
  title: 'title',
  description: 'description',
  status: 'status',
  type: 'type',
  priority: 'priority',
  metrics: 'metrics',
  doneTest: 'done_test',
  summary: 'summary',
  progress: 'progress',
  nextSteps: 'next_steps',
  mandateRef: 'mandate_ref',
  mandateRev: 'mandate_rev',
};
const JSON_FIELDS = new Set<keyof SessionGoalPatch>(['metrics', 'nextSteps']);

const SELECT = `SELECT id, owner_session_id AS ownerSessionId, title, description, status, type,
  priority, metrics, done_test AS doneTest, summary, progress, next_steps AS nextSteps,
  mandate_ref AS mandateRef, mandate_rev AS mandateRev, created_at AS createdAt,
  updated_at AS updatedAt, completed_at AS completedAt, revision FROM space_goals`;

type Row = Omit<SessionGoal, 'metrics' | 'nextSteps'> & { metrics: string; nextSteps: string };

function toGoal(row: Row): SessionGoal {
  return { ...row, metrics: JSON.parse(row.metrics), nextSteps: JSON.parse(row.nextSteps) };
}

export class SessionGoalRepository {
  constructor(
    private readonly db: Database,
    private readonly reactiveDb?: ReactiveDatabase
  ) {}

  get(id: string): SessionGoal | null {
    const row = this.db
      .prepare(`${SELECT} WHERE id = ? AND owner_session_id IS NOT NULL`)
      .get(id) as Row | null;
    return row ? toGoal(row) : null;
  }

  list(ownerSessionId: string, includeClosed: boolean): SessionGoal[] {
    return (
      this.db
        .prepare(
          `${SELECT} WHERE owner_session_id = ? AND (? OR status IN ('active', 'paused'))
           ORDER BY updated_at DESC, id DESC`
        )
        .all(ownerSessionId, includeClosed ? 1 : 0) as Row[]
    ).map(toGoal);
  }

  create(
    ownerSessionId: string,
    draft: SessionGoalDraft,
    source: SpaceGoalEventSource,
    now: number
  ): SessionGoal {
    const id = generateUUID();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO space_goals (id, owner_session_id, title, description, type, priority,
             metrics, done_test, summary, progress, next_steps, mandate_ref, mandate_rev,
             created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .run(
          id,
          ownerSessionId,
          draft.title,
          draft.description ?? '',
          draft.type ?? 'one_shot',
          draft.priority ?? 'normal',
          JSON.stringify(draft.metrics ?? {}),
          draft.doneTest ?? null,
          draft.summary ?? '',
          draft.progress ?? 0,
          JSON.stringify(draft.nextSteps ?? []),
          draft.mandateRef ?? null,
          draft.mandateRev ?? null,
          now,
          now
        );
      this.recordEvent(id, 'created', source, null, this.get(id), now);
    })();
    this.reactiveDb?.notifyChange('space_goals');
    return this.get(id)!;
  }

  update(
    goal: SessionGoal,
    patch: SessionGoalPatch,
    source: SpaceGoalEventSource,
    now: number
  ): SessionGoal {
    const keys = Object.keys(patch) as (keyof SessionGoalPatch)[];
    const completedAt =
      patch.status === undefined
        ? []
        : [patch.status === 'completed' ? (goal.completedAt ?? now) : null];
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE space_goals SET ${keys.map((key) => `${COLUMNS[key]} = ?, `).join('')}updated_at = ?,
             revision = revision + 1${completedAt.length ? ', completed_at = ?' : ''} WHERE id = ?`
        )
        .run(
          ...keys.map((key) =>
            JSON_FIELDS.has(key) ? JSON.stringify(patch[key]) : (patch[key] ?? null)
          ),
          now,
          ...completedAt,
          goal.id
        );
      this.recordEvent(
        goal.id,
        patch.status && patch.status !== goal.status ? 'status_changed' : 'updated',
        source,
        goal,
        this.get(goal.id),
        now
      );
    })();
    this.reactiveDb?.notifyChange('space_goals');
    return this.get(goal.id)!;
  }

  appendJournal(
    goalId: string,
    sessionId: string | null,
    draft: GoalJournalDraft,
    now: number
  ): GoalJournalEntry {
    const runId = draft.runId ?? null;
    const id = generateUUID();
    this.db.transaction(() => {
      if (runId)
        this.db
          .prepare('DELETE FROM goal_journal WHERE goal_id = ? AND run_id = ?')
          .run(goalId, runId);
      this.db
        .prepare(
          `INSERT INTO goal_journal (id, goal_id, run_id, session_id, done, effect, evidence, worked, failed, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          goalId,
          runId,
          sessionId,
          draft.done,
          draft.effect,
          JSON.stringify(draft.evidence),
          draft.worked,
          draft.failed ?? null,
          now
        );
    })();
    this.reactiveDb?.notifyChange('goal_journal');
    return this.listJournal(goalId, null, 1)[0]!;
  }

  listJournal(goalId: string, before: string | null, limit: number): GoalJournalEntry[] {
    return (
      this.db
        .prepare(
          `SELECT id, goal_id AS goalId, run_id AS runId, session_id AS sessionId, done, effect,
             evidence, worked, failed, created_at AS createdAt FROM goal_journal
           WHERE goal_id = ? AND (? IS NULL OR (created_at, rowid) <
             (SELECT created_at, rowid FROM goal_journal WHERE id = ?))
           ORDER BY created_at DESC, rowid DESC LIMIT ?`
        )
        .all(goalId, before, before, limit) as (Omit<GoalJournalEntry, 'evidence'> & {
        evidence: string;
      })[]
    ).map((row) => ({ ...row, evidence: JSON.parse(row.evidence) }));
  }

  private recordEvent(
    goalId: string,
    type: 'created' | 'updated' | 'status_changed',
    source: SpaceGoalEventSource,
    previous: SessionGoal | null,
    next: SessionGoal | null,
    now: number
  ): void {
    this.db
      .prepare(
        `INSERT INTO space_goal_events (id, goal_id, event_type, source, previous_state, new_state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        generateUUID(),
        goalId,
        type,
        source,
        previous ? JSON.stringify(previous) : null,
        next ? JSON.stringify(next) : null,
        now
      );
  }
}
