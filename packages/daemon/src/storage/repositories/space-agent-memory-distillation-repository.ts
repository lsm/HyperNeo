import type { Database as BunDatabase } from 'bun:sqlite';

/**
 * Per-agent cursor tracking how far a long-horizon agent's transcript has been
 * distilled into durable memory. The cursor advances by monotonic
 * `sdk_messages.rowid`, so the distillation pass never reprocesses messages it
 * has already covered (see {@link MemoryDistillationService}).
 *
 * `consecutiveFailures` / `nextAttemptAt` implement exponential backoff: a
 * persistently-failing agent (e.g. a deterministic extraction error) is retried
 * less and less often instead of burning an LLM call every cadence tick.
 */
export interface AgentMemoryDistillationCursor {
  agentId: string;
  spaceId: string;
  sessionId: string;
  lastDistilledRowid: number;
  lastDistilledAt: number;
  messagesDistilled: number;
  memoriesWritten: number;
  lastRunAt: number;
  lastError: string | null;
  consecutiveFailures: number;
  nextAttemptAt: number | null;
  updatedAt: number;
}

export interface AgentMemoryDistillationUpdate {
  spaceId: string;
  sessionId: string;
  lastDistilledRowid: number;
  messagesDistilled: number;
  memoriesWritten: number;
  lastError?: string | null;
}

interface DistillationCursorRow {
  agent_id: string;
  space_id: string;
  session_id: string;
  last_distilled_rowid: number;
  last_distilled_at: number;
  messages_distilled: number;
  memories_written: number;
  last_run_at: number;
  last_error: string | null;
  consecutive_failures: number;
  next_attempt_at: number | null;
  updated_at: number;
}

const LAST_ERROR_MAX_LENGTH = 500;

/** Base backoff after the first failure (30 min — matches the run cadence). */
export const DISTILLATION_BACKOFF_BASE_MS = 30 * 60 * 1000;
/** Cap for the exponential backoff schedule (24 h). */
export const DISTILLATION_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Exponential backoff for the Nth consecutive failure (1-indexed). Doubles each
 * step from the base, capped at the max — so a transient blip still retries at
 * the next cadence, while a deterministic failure ramps down to once per day.
 */
export function computeBackoffMs(consecutiveFailures: number): number {
  const n = Math.max(1, Math.trunc(consecutiveFailures));
  const raw = DISTILLATION_BACKOFF_BASE_MS * 2 ** (n - 1);
  return Math.min(raw, DISTILLATION_BACKOFF_MAX_MS);
}

export class SpaceAgentMemoryDistillationRepository {
  constructor(private db: BunDatabase) {}

  getCursor(agentId: string): AgentMemoryDistillationCursor | null {
    const row = this.db
      .prepare(`SELECT * FROM space_agent_memory_distillation WHERE agent_id = ?`)
      .get(agentId) as DistillationCursorRow | undefined;
    return row ? rowToCursor(row) : null;
  }

  /**
   * Record a successful distillation pass and advance the cursor to
   * `lastDistilledRowid`. Resets the failure backoff. Idempotent: re-running
   * with the same rowid refreshes counts/lastRunAt without moving the cursor
   * backwards.
   */
  recordSuccess(agentId: string, update: AgentMemoryDistillationUpdate): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO space_agent_memory_distillation
				 (agent_id, space_id, session_id, last_distilled_rowid, last_distilled_at,
					messages_distilled, memories_written, last_run_at, last_error,
					consecutive_failures, next_attempt_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?)
				 ON CONFLICT(agent_id) DO UPDATE SET
					space_id = excluded.space_id,
					session_id = excluded.session_id,
					last_distilled_rowid = MAX(excluded.last_distilled_rowid, space_agent_memory_distillation.last_distilled_rowid),
					last_distilled_at = excluded.last_distilled_at,
					messages_distilled = excluded.messages_distilled,
					memories_written = excluded.memories_written,
					last_run_at = excluded.last_run_at,
					last_error = NULL,
					consecutive_failures = 0,
					next_attempt_at = NULL,
					updated_at = excluded.updated_at`
      )
      .run(
        agentId,
        update.spaceId,
        update.sessionId,
        update.lastDistilledRowid,
        now,
        update.messagesDistilled,
        update.memoriesWritten,
        now,
        now
      );
  }

  /**
   * Record a failed pass without advancing the cursor, so the un-distilled
   * messages are retried. Bumps the consecutive-failure counter and schedules
   * the next attempt with exponential backoff.
   */
  recordError(agentId: string, spaceId: string, sessionId: string, error: unknown): void {
    const existing = this.getCursor(agentId);
    const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1;
    const nextAttemptAt = Date.now() + computeBackoffMs(consecutiveFailures);
    const message = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO space_agent_memory_distillation
				 (agent_id, space_id, session_id, last_distilled_rowid, last_distilled_at,
					messages_distilled, memories_written, last_run_at, last_error,
					consecutive_failures, next_attempt_at, updated_at)
				 VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?)
				 ON CONFLICT(agent_id) DO UPDATE SET
					space_id = excluded.space_id,
					session_id = excluded.session_id,
					last_run_at = excluded.last_run_at,
					last_error = excluded.last_error,
					consecutive_failures = excluded.consecutive_failures,
					next_attempt_at = excluded.next_attempt_at,
					updated_at = excluded.updated_at`
      )
      .run(
        agentId,
        spaceId,
        sessionId,
        now,
        message.slice(0, LAST_ERROR_MAX_LENGTH),
        consecutiveFailures,
        nextAttemptAt,
        now
      );
  }

  /**
   * Advance only the cursor rowid (used when a pass read messages but the
   * extractor returned no durable facts — the content is still "processed").
   * Resets the failure backoff.
   */
  advanceCursor(
    agentId: string,
    spaceId: string,
    sessionId: string,
    lastDistilledRowid: number,
    messagesDistilled: number
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO space_agent_memory_distillation
				 (agent_id, space_id, session_id, last_distilled_rowid, last_distilled_at,
					messages_distilled, memories_written, last_run_at, last_error,
					consecutive_failures, next_attempt_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, 0, NULL, ?)
				 ON CONFLICT(agent_id) DO UPDATE SET
					space_id = excluded.space_id,
					session_id = excluded.session_id,
					last_distilled_rowid = MAX(excluded.last_distilled_rowid, space_agent_memory_distillation.last_distilled_rowid),
					last_distilled_at = excluded.last_distilled_at,
					messages_distilled = excluded.messages_distilled,
					last_run_at = excluded.last_run_at,
					last_error = NULL,
					consecutive_failures = 0,
					next_attempt_at = NULL,
					updated_at = excluded.updated_at`
      )
      .run(agentId, spaceId, sessionId, lastDistilledRowid, now, messagesDistilled, now, now);
  }

  listAll(): AgentMemoryDistillationCursor[] {
    const rows = this.db
      .prepare(`SELECT * FROM space_agent_memory_distillation ORDER BY updated_at DESC`)
      .all() as DistillationCursorRow[];
    return rows.map(rowToCursor);
  }

  /**
   * Clamp the cursor for a session's agents after a rewind deletes the
   * transcript tail. `sdk_messages` has implicit rowid WITHOUT AUTOINCREMENT, so
   * after the high-rowid tail is removed, new messages get rowids at
   * `MAX(remaining)+1` — which can be `<=` the stale `last_distilled_rowid` and
   * get silently skipped by the `rowid > cursor` filter. Clamping the cursor
   * down to the max remaining rowid ensures those new messages are still
   * distilled. No-op for sessions with no distillation cursor (non-LH sessions).
   */
  clampCursorToRemainingMessages(sessionId: string): number {
    const maxRemaining =
      (
        this.db
          .prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM sdk_messages WHERE session_id = ?`)
          .get(sessionId) as { m: number | null } | undefined
      )?.m ?? 0;
    const result = this.db
      .prepare(
        `UPDATE space_agent_memory_distillation
				 SET last_distilled_rowid = ?, updated_at = ?
				 WHERE session_id = ? AND last_distilled_rowid > ?`
      )
      .run(maxRemaining, Date.now(), sessionId, maxRemaining);
    return result.changes;
  }
}

function rowToCursor(row: DistillationCursorRow): AgentMemoryDistillationCursor {
  return {
    agentId: row.agent_id,
    spaceId: row.space_id,
    sessionId: row.session_id,
    lastDistilledRowid: row.last_distilled_rowid,
    lastDistilledAt: row.last_distilled_at,
    messagesDistilled: row.messages_distilled,
    memoriesWritten: row.memories_written,
    lastRunAt: row.last_run_at,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
    nextAttemptAt: row.next_attempt_at,
    updatedAt: row.updated_at,
  };
}
