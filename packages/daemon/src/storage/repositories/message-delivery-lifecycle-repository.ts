/**
 * MessageDeliveryLifecycleRepository
 *
 * Durable, append-only ledger of user-message delivery lifecycle events, keyed
 * by the stable SDK message UUID. Each persisted user message accumulates a
 * timeline of stages as it travels from persistence → wake → in-memory queue
 * claim → SDK acceptance → first output → turn completion (or failure).
 *
 * Purpose (task #859, phase 1): establish end-to-end observability and durable
 * correlation for message delivery BEFORE introducing automatic retries. A
 * developer can read the timeline for any message UUID and identify exactly
 * where it stopped; the diagnostics query surfaces persisted-but-unclaimed and
 * stale messages plus inter-stage latencies.
 *
 * Stage semantics (see docs/features/message-delivery-lifecycle.md):
 *   persisted       — message written to sdk_messages (send_status enqueued|deferred)
 *   wake_requested  — daemon called ensureQueryStarted() to deliver this message
 *   accepted        — message entered the in-memory MessageQueue (daemon claimed it)
 *   consumed        — SDK pulled the message from the input generator (turn begins)
 *   first_progress  — first assistant output for this message's turn
 *   completed       — SDK emitted a terminal result for this message's turn
 *   failed          — delivery did not complete (timeout / orphaned / delivery error)
 *
 * Recording is best-effort: record() never throws — observability must not
 * break the delivery path.
 */

import { generateUUID } from '@hyperneo/shared';
import type { Database as BunDatabase } from '../sqlite-compat';
import { Logger } from '../../lib/logger';

export type MessageDeliveryStage =
  | 'persisted'
  | 'wake_requested'
  | 'accepted'
  | 'consumed'
  | 'first_progress'
  | 'completed'
  | 'failed';

/** Stages that represent a delivery which has NOT yet reached a terminal outcome. */
const NON_TERMINAL_STAGES: ReadonlySet<MessageDeliveryStage> = new Set([
  'persisted',
  'wake_requested',
  'accepted',
  'consumed',
  'first_progress',
]);

export interface MessageDeliveryLifecycleEvent {
  messageId: string;
  sessionId: string;
  stage: MessageDeliveryStage;
  detail: Record<string, unknown> | null;
  createdAt: number;
}

/**
 * Result of a per-message latest-stage lookup. `{ ok: true, value: null }` means
 * "read succeeded, no lifecycle evidence" — the normal pre-ledger / unknown-
 * message case. `{ ok: false }` means the read itself failed (corrupt table or
 * the message_id index the lookup walks). A destructive caller must NOT treat a
 * read failure as missing evidence — that inversion would fail messages the
 * ledger was meant to protect (task #859 round-15 P2).
 */
export type LatestStageResult =
  | { ok: true; value: { stage: MessageDeliveryStage; createdAt: number } | null }
  | { ok: false };

export interface DeliveryDiagnosticsStuckItem {
  messageId: string;
  sessionId: string;
  stage: MessageDeliveryStage;
  ageMs: number;
}

export interface DeliveryLatencySummary {
  count: number;
  avgMs: number | null;
  maxMs: number | null;
}

export interface MessageDeliveryDiagnosticsOptions {
  /** Scope to a single session when provided. */
  sessionId?: string;
  /** A message whose latest stage is non-terminal and older than this is "stale". */
  staleMs?: number;
  /** Only consider messages with activity at/after (now - sinceMs) for latency. */
  sinceMs?: number;
  /**
   * Bounds the latest-stage / stuck-message scan to messages with activity at/
   * after (now - scanWindowMs). The ledger is append-only with no retention, so
   * an unbounded daemon-wide ROW_NUMBER() scan grows with history. Default 24h.
   * Stuck messages older than the window are invisible to this query — raise it
   * or use {@link deleteOlderThan} to enforce retention. See task #859 review F7.
   */
  scanWindowMs?: number;
}

export interface MessageDeliveryDiagnostics {
  generatedAt: number;
  staleThresholdMs: number;
  /** The scan window (ms) applied to the stuck-message / latest-stage scan. */
  scanWindowMs: number;
  /** Count of messages whose LATEST recorded stage is each stage. */
  totalsByLatestStage: Partial<Record<MessageDeliveryStage, number>>;
  /** Messages that were persisted but never reached a terminal outcome. */
  unclaimed: DeliveryDiagnosticsStuckItem[];
  /** Non-terminal messages older than the stale threshold. */
  stale: DeliveryDiagnosticsStuckItem[];
  latency: {
    /** wake_requested → accepted (daemon wake to in-memory claim). */
    wakeToAccept: DeliveryLatencySummary;
    /** accepted → first_progress (claim to first assistant output). */
    acceptToFirstProgress: DeliveryLatencySummary;
    /** accepted → consumed (claim to SDK acceptance). */
    acceptToConsumed: DeliveryLatencySummary;
  };
}

interface LatestStageRow {
  message_id: string;
  session_id: string;
  stage: MessageDeliveryStage;
  created_at: number;
  detail: string | null;
}

interface LatencyPivotRow {
  wake: number | null;
  accepted: number | null;
  consumed: number | null;
  first_progress: number | null;
}

function parseDetail(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export class MessageDeliveryLifecycleRepository {
  private logger: Logger;

  constructor(private db: BunDatabase) {
    this.logger = new Logger('MessageDeliveryLifecycle');
  }

  /**
   * Append a lifecycle event. Best-effort: swallows errors so observability
   * never breaks message delivery.
   */
  record(
    sessionId: string,
    messageId: string,
    stage: MessageDeliveryStage,
    detail?: Record<string, unknown>
  ): void {
    if (!sessionId || !messageId) return;
    try {
      this.db
        .prepare(
          `INSERT INTO message_delivery_lifecycle (id, session_id, message_id, stage, detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          generateUUID(),
          sessionId,
          messageId,
          stage,
          detail ? JSON.stringify(detail) : null,
          Date.now()
        );
    } catch (error) {
      this.logger.warn(`Failed to record delivery stage '${stage}' for ${messageId}:`, error);
    }
  }

  /** Ordered timeline for a message UUID — answers "where did it stop?". */
  getTimeline(messageId: string): MessageDeliveryLifecycleEvent[] {
    if (!messageId) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT stage, detail, created_at, session_id, message_id
             FROM message_delivery_lifecycle
            WHERE message_id = ?
            ORDER BY created_at ASC, rowid ASC`
        )
        .all(messageId) as Array<{
        stage: MessageDeliveryStage;
        detail: string | null;
        created_at: number;
        session_id: string;
        message_id: string;
      }>;
      return rows.map((row) => ({
        messageId: row.message_id,
        sessionId: row.session_id,
        stage: row.stage,
        detail: parseDetail(row.detail),
        createdAt: row.created_at,
      }));
    } catch (error) {
      this.logger.warn(`Failed to read delivery timeline for ${messageId}:`, error);
      return [];
    }
  }

  /** The most recent stage recorded for a message, or null if none. */
  getLatestStage(messageId: string): LatestStageResult {
    if (!messageId) return { ok: true, value: null };
    try {
      const row = this.db
        .prepare(
          `SELECT stage, created_at
             FROM message_delivery_lifecycle
            WHERE message_id = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT 1`
        )
        .get(messageId) as { stage: MessageDeliveryStage; created_at: number } | null;
      return { ok: true, value: row ? { stage: row.stage, createdAt: row.created_at } : null };
    } catch (error) {
      this.logger.warn(`Failed to read latest delivery stage for ${messageId}:`, error);
      return { ok: false };
    }
  }

  /**
   * True when the ledger can be read at all. Fast-fail for whole-table
   * corruption (the probe walks the same ordered-read shape): a destructive
   * caller skips ledger-gated candidates when false, rather than failing them
   * blindly. It does NOT cover per-message-index corruption — getLatestStage's
   * `{ ok: false }` result does that. See task #859 round-13/round-15.
   */
  isReadable(): boolean {
    try {
      this.db
        .prepare(
          `SELECT stage, created_at
             FROM message_delivery_lifecycle
            ORDER BY created_at DESC, rowid DESC
            LIMIT 1`
        )
        .get();
      return true;
    } catch (error) {
      this.logger.warn('Delivery lifecycle ledger is unreadable:', error);
      return false;
    }
  }

  /**
   * Queryable diagnostics: where are messages stuck, and how long do the
   * inter-stage transitions take?
   */
  getDiagnostics(options: MessageDeliveryDiagnosticsOptions = {}): MessageDeliveryDiagnostics {
    const now = Date.now();
    const staleMs = options.staleMs ?? 60_000;
    const sinceMs = options.sinceMs ?? 60 * 60 * 1000;
    const scanWindowMs = options.scanWindowMs ?? 24 * 60 * 60 * 1000;
    const sinceCutoff = now - sinceMs;
    const scanCutoff = now - scanWindowMs;

    const latest = this.getLatestStages(options.sessionId, scanCutoff);

    const totalsByLatestStage: Partial<Record<MessageDeliveryStage, number>> = {};
    const unclaimed: DeliveryDiagnosticsStuckItem[] = [];
    const stale: DeliveryDiagnosticsStuckItem[] = [];

    for (const row of latest) {
      totalsByLatestStage[row.stage] = (totalsByLatestStage[row.stage] ?? 0) + 1;
      const ageMs = now - row.created_at;

      // An intentionally-deferred message (manual mode / deferred while busy or
      // rate-limited) is expected to sit at `persisted` until an explicit replay
      // — no delivery was attempted, so it is not stranded. The persisted event
      // carries sendStatus in its detail. See task #859 N5.
      const intentionallyDeferred =
        row.stage === 'persisted' && parseDetail(row.detail)?.sendStatus === 'deferred';
      if (intentionallyDeferred) {
        continue;
      }

      // Persisted but never claimed by the daemon queue (no accepted/consumed/...).
      if (row.stage === 'persisted' || row.stage === 'wake_requested') {
        unclaimed.push({
          messageId: row.message_id,
          sessionId: row.session_id,
          stage: row.stage,
          ageMs,
        });
      }

      if (NON_TERMINAL_STAGES.has(row.stage) && ageMs > staleMs) {
        stale.push({
          messageId: row.message_id,
          sessionId: row.session_id,
          stage: row.stage,
          ageMs,
        });
      }
    }

    const pivots = this.getLatencyPivots(options.sessionId, sinceCutoff);
    const wakeToAccept = summarize(deltas(pivots, 'wake', 'accepted'));
    const acceptToConsumed = summarize(deltas(pivots, 'accepted', 'consumed'));
    const acceptToFirstProgress = summarize(deltas(pivots, 'accepted', 'first_progress'));

    return {
      generatedAt: now,
      staleThresholdMs: staleMs,
      scanWindowMs,
      totalsByLatestStage,
      unclaimed: unclaimed.sort((a, b) => b.ageMs - a.ageMs),
      stale: stale.sort((a, b) => b.ageMs - a.ageMs),
      latency: { wakeToAccept, acceptToConsumed, acceptToFirstProgress },
    };
  }

  /**
   * Drop all lifecycle rows for a message — used when a pending message is
   * intentionally cancelled so it stops surfacing as unclaimed/stale.
   */
  deleteForMessage(messageId: string): void {
    if (!messageId) return;
    try {
      this.db.prepare('DELETE FROM message_delivery_lifecycle WHERE message_id = ?').run(messageId);
    } catch (error) {
      this.logger.warn(`Failed to delete delivery lifecycle rows for ${messageId}:`, error);
    }
  }

  /**
   * Retention sweep: delete rows older than `cutoffMs` (epoch ms). The ledger is
   * append-only with no automatic TTL; this lets a caller bound growth. NOTE: it
   * is NOT auto-invoked in phase 1 — retention policy (cadence + age) is phase 2.
   *
   * Preserves terminal (`completed`/`failed`) evidence for any message whose
   * sdk_messages row is still `send_status = 'consumed'`. `send_status` has no
   * delivered/finished state, so a delivered-and-completed message can remain
   * `consumed`; MessageRecoveryHandler relies on this ledger's terminal record
   * (task #859 N6/F13) to avoid re-orphaning it after a restart. Deleting that
   * evidence here would make recovery wrongly flip a delivered message to
   * `failed`. See task #859 round-5 P2 (retention vs recovery).
   *
   * Returns the number of rows deleted.
   */
  deleteOlderThan(cutoffMs: number): number {
    try {
      const result = this.db
        .prepare(
          `DELETE FROM message_delivery_lifecycle
           WHERE created_at < ?
             AND NOT (
               stage IN ('completed', 'failed')
               AND EXISTS (
                 SELECT 1 FROM sdk_messages s
                 WHERE s.session_id = message_delivery_lifecycle.session_id
                   AND s.sdk_uuid = message_delivery_lifecycle.message_id
                   AND COALESCE(s.send_status, 'consumed') = 'consumed'
               )
             )`
        )
        .run(cutoffMs);
      return result.changes;
    } catch (error) {
      this.logger.warn('Failed to sweep delivery lifecycle rows:', error);
      return 0;
    }
  }

  /** Latest stage row per message UUID, optionally scoped to a session + window. */
  private getLatestStages(sessionId: string | undefined, scanCutoff: number): LatestStageRow[] {
    try {
      const clauses = ['created_at >= ?'];
      const params: Array<string | number> = [scanCutoff];
      if (sessionId) {
        clauses.push('session_id = ?');
        params.push(sessionId);
      }
      const where = `WHERE ${clauses.join(' AND ')}`;
      const rows = this.db
        .prepare(
          `SELECT message_id, session_id, stage, created_at, detail FROM (
              SELECT message_id, session_id, stage, created_at, detail,
                ROW_NUMBER() OVER (
                  PARTITION BY message_id ORDER BY created_at DESC, rowid DESC
                ) AS rn
                FROM message_delivery_lifecycle
                ${where}
            ) WHERE rn = 1`
        )
        .all(...params) as LatestStageRow[];
      return rows;
    } catch (error) {
      this.logger.warn('Failed to read latest delivery stages:', error);
      return [];
    }
  }

  /**
   * Per-message first-occurrence timestamps for the latency-relevant stages.
   * Scoped to activity at/after `sinceCutoff` so the aggregate reflects recent
   * traffic, not the full history.
   *
   * Phase-1 limitation (task #859 review F6): these independent `MIN` pivots
   * pair the FIRST source stage with the FIRST target stage across all delivery
   * attempts. When a message is re-enqueued after a queue-timeout retry, the
   * source/target can come from different attempts, overstating latency by the
   * retry gap. The authoritative per-attempt timeline is {@link getTimeline};
   * phase 2 (delivery-attempt IDs) will make these aggregates attempt-correct.
   */
  private getLatencyPivots(sessionId: string | undefined, sinceCutoff: number): LatencyPivotRow[] {
    try {
      const clauses = ['created_at >= ?'];
      const params: Array<string | number> = [sinceCutoff];
      if (sessionId) {
        clauses.push('session_id = ?');
        params.push(sessionId);
      }
      const rows = this.db
        .prepare(
          `SELECT message_id,
              MIN(CASE WHEN stage = 'wake_requested' THEN created_at END) AS wake,
              MIN(CASE WHEN stage = 'accepted' THEN created_at END) AS accepted,
              MIN(CASE WHEN stage = 'consumed' THEN created_at END) AS consumed,
              MIN(CASE WHEN stage = 'first_progress' THEN created_at END) AS first_progress
             FROM message_delivery_lifecycle
            WHERE ${clauses.join(' AND ')}
            GROUP BY message_id`
        )
        .all(...params) as LatencyPivotRow[];
      return rows;
    } catch (error) {
      this.logger.warn('Failed to read delivery latency pivots:', error);
      return [];
    }
  }
}

function deltas(
  pivots: LatencyPivotRow[],
  from: keyof LatencyPivotRow,
  to: keyof LatencyPivotRow
): number[] {
  const out: number[] = [];
  for (const p of pivots) {
    const fromTs = p[from];
    const toTs = p[to];
    if (typeof fromTs === 'number' && typeof toTs === 'number') {
      const delta = toTs - fromTs;
      if (delta >= 0) out.push(delta);
    }
  }
  return out;
}

function summarize(values: number[]): DeliveryLatencySummary {
  if (values.length === 0) {
    return { count: 0, avgMs: null, maxMs: null };
  }
  let sum = 0;
  let max = 0;
  for (const v of values) {
    sum += v;
    if (v > max) max = v;
  }
  return {
    count: values.length,
    avgMs: Math.round(sum / values.length),
    // Track the max in the loop rather than Math.max(...values): an operator
    // widening the caller-controlled sinceMs window can push hundreds of
    // thousands of samples through the spread, which blows the runtime's
    // argument limit (RangeError) and fails the diagnostics RPC.
    maxMs: max,
  };
}
