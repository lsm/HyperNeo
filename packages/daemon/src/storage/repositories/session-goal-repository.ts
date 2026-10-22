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
import type { SessionSchedule } from './session-schedule-repository.ts';

type WakeSchedule = Pick<SessionSchedule, 'cadence' | 'nudgeEvery'>;

const COLUMNS: Record<keyof SessionGoalPatch, string> = {
  title: 'title',
  description: 'description',
  status: 'status',
  type: 'type',
  priority: 'priority',
  metrics: 'metrics',
  doneTest: 'done_test',
  summary: 'summary',
  worksNote: 'works_note',
  progress: 'progress',
  nextSteps: 'next_steps',
  mandateRef: 'mandate_ref',
  mandateRev: 'mandate_rev',
};
const JSON_FIELDS = new Set<keyof SessionGoalPatch>(['metrics', 'nextSteps']);

const SELECT = `SELECT id, owner_session_id AS ownerSessionId, title, description, status, type,
  priority, metrics, done_test AS doneTest, summary, works_note AS worksNote, progress, next_steps AS nextSteps,
  mandate_ref AS mandateRef, mandate_rev AS mandateRev, created_at AS createdAt,
  updated_at AS updatedAt, completed_at AS completedAt, revision FROM neo_goals`;

type Row = Omit<SessionGoal, 'metrics' | 'nextSteps'> & { metrics: string; nextSteps: string };

function toGoal(row: Row): SessionGoal {
  return { ...row, metrics: JSON.parse(row.metrics), nextSteps: JSON.parse(row.nextSteps) };
}

const JOURNAL_SELECT = `SELECT id, goal_id AS goalId, run_id AS runId, session_id AS sessionId, done,
  effect, evidence, worked, failed, created_at AS createdAt FROM goal_journal`;

type JournalRow = Omit<GoalJournalEntry, 'evidence'> & { evidence: string };

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
    _source: SpaceGoalEventSource,
    now: number,
    changed?: (goal: SessionGoal) => void
  ): SessionGoal {
    const id = generateUUID();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO neo_goals (id, owner_session_id, title, description, type, priority,
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
      changed?.(this.get(id)!);
    })();
    this.reactiveDb?.notifyChange('neo_goals');
    return this.get(id)!;
  }

  update(
    goal: SessionGoal,
    patch: SessionGoalPatch,
    _source: SpaceGoalEventSource,
    now: number,
    changed?: (goal: SessionGoal) => void
  ): SessionGoal {
    const keys = Object.keys(patch) as (keyof SessionGoalPatch)[];
    const completedAt =
      patch.status === undefined
        ? []
        : [patch.status === 'completed' ? (goal.completedAt ?? now) : null];
    this.db.transaction(() => {
      const compaction = patch.worksNote === undefined ? null : this.factState(goal.id);
      this.db
        .prepare(
          `UPDATE neo_goals SET ${keys.map((key) => `${COLUMNS[key]} = ?, `).join('')}updated_at = ?,
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
      if (compaction) {
        this.db
          .prepare('UPDATE neo_goals SET works_note_through = ? WHERE id = ?')
          .run(compaction.entries, goal.id);
      }
      changed?.(this.get(goal.id)!);
    })();
    this.reactiveDb?.notifyChange('neo_goals');
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
    this.db
      .prepare(
        `INSERT INTO goal_journal (id, goal_id, run_id, session_id, done, effect, evidence, worked, failed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (goal_id, run_id) WHERE run_id IS NOT NULL DO UPDATE SET
           session_id = excluded.session_id, done = excluded.done, effect = excluded.effect,
           evidence = excluded.evidence, worked = excluded.worked, failed = excluded.failed`
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
    this.reactiveDb?.notifyChange('goal_journal');
    return this.journalEntry(goalId, runId === null ? { id } : { runId })!;
  }

  factState(id: string): {
    lines: string[];
    note: string | null;
    through: number | null;
    entries: number;
  } {
    const row = this.db
      .prepare(`SELECT facts_lines AS lines, works_note AS note, works_note_through AS through,
        (SELECT COUNT(*) FROM goal_journal WHERE goal_id = neo_goals.id) AS entries
        FROM neo_goals WHERE id = ?`)
      .get(id) as {
      lines: string | null;
      note: string | null;
      through: number | null;
      entries: number;
    };
    return { ...row, lines: JSON.parse(row.lines ?? '[]') };
  }

  wakeSchedule(id: string): WakeSchedule | null {
    const row = this.db
      .prepare('SELECT wake_schedule AS config FROM neo_goals WHERE id = ?')
      .get(id) as { config: string | null };
    return row.config ? (JSON.parse(row.config) as WakeSchedule) : null;
  }

  saveWakeSchedule(id: string, config: WakeSchedule): void {
    this.db
      .prepare('UPDATE neo_goals SET wake_schedule = ? WHERE id = ?')
      .run(JSON.stringify(config), id);
  }

  recordFacts(id: string, lines: readonly string[]): void {
    this.db
      .prepare('UPDATE neo_goals SET facts_lines = ? WHERE id = ?')
      .run(JSON.stringify(lines), id);
  }

  journalEntry(goalId: string, key: { id: string } | { runId: string }): GoalJournalEntry | null {
    const row = this.db
      .prepare(`${JOURNAL_SELECT} WHERE goal_id = ? AND ${'id' in key ? 'id' : 'run_id'} = ?`)
      .get(goalId, 'id' in key ? key.id : key.runId) as JournalRow | null;
    return row ? { ...row, evidence: JSON.parse(row.evidence) } : null;
  }

  listJournal(goalId: string, before: string | null, limit: number): GoalJournalEntry[] {
    return (
      this.db
        .prepare(
          `${JOURNAL_SELECT} WHERE goal_id = ? AND (? IS NULL OR (created_at, rowid) <
             (SELECT created_at, rowid FROM goal_journal WHERE id = ?))
           ORDER BY created_at DESC, rowid DESC LIMIT ?`
        )
        .all(goalId, before, before, limit) as JournalRow[]
    ).map((row) => ({ ...row, evidence: JSON.parse(row.evidence) }));
  }
}
