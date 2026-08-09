import type { Database as BunDatabase } from '../sqlite-compat';
import { generateUUID } from '@hyperneo/shared';

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'dead';

export interface Job {
  id: string;
  queue: string;
  status: JobStatus;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  priority: number;
  maxRetries: number;
  retryCount: number;
  runAt: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  /** Opaque generation assigned on each claim; fences reclaimed predecessors. */
  claimToken: string | null;
}

export interface EnqueueParams {
  queue: string;
  payload: Record<string, unknown>;
  priority?: number;
  maxRetries?: number;
  runAt?: number;
}

export interface EnqueueUniquePendingParams extends EnqueueParams {
  matchPayload: Record<string, unknown>;
  activeStatuses?: JobStatus[];
}

/**
 * A payload equality predicate (`payload[jsonPath] === equals`). Used by the
 * processor's exempt dequeue pass so jobs the lane declares exempt (e.g.
 * message_delivery `role:'steer'`) are claimed separately from the
 * maxConcurrent-capped turn jobs. See message-delivery-v2.md + Codex (#2587).
 */
export interface PayloadMatch {
  /** JSON path into payload, e.g. '$.role'. */
  path: string;
  /** Scalar value the path must equal. */
  equals: string;
}

export class JobQueueRepository {
  constructor(private db: BunDatabase) {}

  enqueue(params: EnqueueParams): Job {
    const id = generateUUID();
    const now = Date.now();

    const stmt = this.db.prepare(
      `INSERT INTO job_queue (id, queue, status, payload, result, error, priority, max_retries, retry_count, run_at, created_at, started_at, completed_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    stmt.run(
      id,
      params.queue,
      'pending',
      JSON.stringify(params.payload),
      null,
      null,
      params.priority ?? 0,
      params.maxRetries ?? 3,
      0,
      params.runAt ?? now,
      now,
      null,
      null
    );

    return this.getJob(id)!;
  }

  enqueueUniquePending(params: EnqueueUniquePendingParams): Job | null {
    return this.db.transaction(() => {
      if (this.findMatchingActiveJob(params.queue, params.matchPayload, params.activeStatuses)) {
        return null;
      }
      return this.enqueue(params);
    })();
  }

  dequeue(queue: string, limit: number = 1, exclude?: PayloadMatch): Job[] {
    const claimed: Job[] = [];

    const txn = this.db.transaction(() => {
      let sql = `SELECT * FROM job_queue WHERE queue = ? AND status = 'pending' AND run_at <= ?`;
      const params: (string | number)[] = [queue, Date.now()];
      if (exclude) {
        // Leave jobs matching `exclude` (e.g. role:'steer') for the processor's
        // exempt pass so they aren't claimed against the capped budget. COALESCE
        // keeps path-less rows claimable (NULL → '' ≠ equals). See #2587.
        sql += ` AND COALESCE(json_extract(payload, ?), '') != ?`;
        params.push(exclude.path, exclude.equals);
      }
      sql += ` ORDER BY priority DESC, run_at ASC, created_at ASC, rowid ASC LIMIT ?`;
      params.push(limit);

      const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
      this.claimRows(rows, claimed);
    });

    txn();
    return claimed;
  }

  /**
   * Claim pending jobs whose payload matches {@link spec} (e.g. role:'steer'),
   * atomically pending→processing. The processor's exempt pass calls this so
   * matching jobs run even when the capped slots (`maxConcurrent`) are full —
   * they count against a separate exempt budget, not the turn budget. This is
   * what lets a mid-turn steer reach the live turn instead of being promoted to
   * a later turn under slot pressure. See message-delivery-v2.md + Codex (#2587).
   */
  dequeueExempt(queue: string, spec: PayloadMatch, limit: number = 1): Job[] {
    const claimed: Job[] = [];

    const txn = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM job_queue
             WHERE queue = ? AND status = 'pending' AND run_at <= ?
               AND json_extract(payload, ?) = ?
           ORDER BY priority DESC, run_at ASC, created_at ASC, rowid ASC LIMIT ?`
        )
        .all(queue, Date.now(), spec.path, spec.equals, limit) as Record<string, unknown>[];
      this.claimRows(rows, claimed);
    });

    txn();
    return claimed;
  }

  private claimRows(rows: Record<string, unknown>[], claimed: Job[]): void {
    const now = Date.now();
    for (const row of rows) {
      const claimToken = generateUUID();
      this.db
        .prepare(
          `UPDATE job_queue
              SET status = 'processing', started_at = ?,
                  payload = json_set(payload, '$.__claimToken', ?)
            WHERE id = ? AND status = 'pending'`
        )
        .run(now, claimToken, row.id as string);
      const job = this.getJob(row.id as string);
      if (job?.claimToken === claimToken) claimed.push(job);
    }
  }

  /**
   * Return a claimed (`processing`) job back to `pending` with a specific
   * `run_at`, WITHOUT incrementing `retry_count` or recording an error. Used by
   * the message-delivery handler to PARK a turn whose query startup is blocked
   * (e.g. sdk_resume_choice) so it is re-claimed later instead of failing. The
   * job-queue processor's auto-`complete()` on handler return is a no-op here
   * because the row is no longer `processing`. See message-delivery-v2.md §8.
   */
  requeue(jobId: string, runAt: number, claimToken?: string | null): Job | null {
    const stmt = this.db.prepare(
      `UPDATE job_queue SET status = 'pending', run_at = ?, started_at = NULL
        WHERE id = ? AND status = 'processing'
          AND (? IS NULL OR json_extract(payload, '$.__claimToken') = ?)`
    );
    const res = stmt.run(runAt, jobId, claimToken ?? null, claimToken ?? null);
    if (res.changes === 0) return null;
    return this.getJob(jobId);
  }

  /**
   * Requeue + change the job's role in place (e.g. a steer promoted to a turn),
   * atomically converting THIS job rather than completing it and enqueuing a
   * second. Avoids the crash-window double-deliver of a separate promote job
   * (the active-turn index dedups turn-role-per-session, not per-messageUuid).
   * `runAt` defaults to now so the converted job is immediately claimable. The
   * per-session-active-turn unique index still applies: if another turn became
   * active between the promote check and this write, the UPDATE raises a UNIQUE
   * violation the caller can catch (fall back to requeuing as a steer). See
   * message-delivery-v2.md §8 (promote).
   */
  requeueAs(jobId: string, role: string, runAt: number): Job | null {
    const res = this.db
      .prepare(
        `UPDATE job_queue
           SET status = 'pending',
               payload = json_set(payload, '$.role', ?),
               run_at = ?,
               started_at = NULL
         WHERE id = ? AND status = 'processing'`
      )
      .run(role, runAt, jobId);
    if (res.changes === 0) return null;
    return this.getJob(jobId);
  }

  /**
   * Requeue EVERY `processing` job in a lane back to `pending` (`run_at = runAt`),
   * WITHOUT a retry bump. Used on daemon shutdown so an in-flight message_delivery
   * turn — whose handler is still awaiting the SDK turn — is immediately
   * reclaimable on the next boot's eager `reclaimStale`, instead of staying
   * `processing` with a fresh heartbeat and blocking reclamation for the 5-minute
   * stale window (which would also leave the active-turn index pointing at a turn
   * no live handler is driving). The still-running handler's later
   * `complete()`/`fail()` is a no-op (the row is no longer `processing`). See
   * message-delivery-v2.md §10 + Codex (#2593).
   */
  requeueAllProcessing(queue: string, runAt: number): number {
    const res = this.db
      .prepare(
        `UPDATE job_queue SET status = 'pending', run_at = ?, started_at = NULL WHERE queue = ? AND status = 'processing'`
      )
      .run(runAt, queue);
    return res.changes;
  }

  /**
   * Refresh `started_at` on a `processing` job WITHOUT changing status — a lease
   * heartbeat so the generic `reclaimStale` sweep (default 5min threshold) does
   * not reclaim a long-but-live SDK turn and re-deliver it (duplicate turn). The
   * message-delivery handler heartbeats this throughout the turn await; a
   * crashed handler stops heartbeating, so reclaimStale still recovers it. See
   * message-delivery-v2.md §10 + Codex review (live-turn reclaim).
   */
  touchStartedAt(jobId: string, claimToken?: string | null): boolean {
    const result = claimToken
      ? this.db
          .prepare(
            `UPDATE job_queue SET started_at = ?
              WHERE id = ? AND status = 'processing'
                AND json_extract(payload, '$.__claimToken') = ?`
          )
          .run(Date.now(), jobId, claimToken)
      : this.db
          .prepare(`UPDATE job_queue SET started_at = ? WHERE id = ? AND status = 'processing'`)
          .run(Date.now(), jobId);
    return result.changes > 0;
  }

  /** True only while this exact claimed attempt still owns the processing row. */
  isClaimCurrent(jobId: string, claimToken: string | null): boolean {
    if (!claimToken) return false;
    return !!this.db
      .prepare(
        `SELECT 1 FROM job_queue
          WHERE id = ? AND status = 'processing'
            AND json_extract(payload, '$.__claimToken') = ?`
      )
      .get(jobId, claimToken);
  }

  /**
   * Cancel (delete) every ACTIVE (pending/processing) `message_delivery` job for
   * a session. Used at the START of `session.archive` (before any teardown) so a
   * job claimed concurrently with the archive cannot drive a turn against the
   * session while its agent/transcript/worktree are being torn down (phases 1–3
   * run before the phase-4 `status='archived'` flip the handler guard checks).
   * A processing job whose in-flight handler is still running self-settles when
   * archive phase 1 cleans up the agent (its later complete()/fail()/requeue() is
   * a no-op — the row is gone). The persisted message stays in `sdk_messages`.
   * See message-delivery-v2.md + Codex (#3742616723 archive TOCTOU).
   */
  cancelForSession(sessionId: string, queue: string = 'message_delivery'): number {
    return this.cancelForSessionWithMessages(sessionId, queue).length;
  }

  /**
   * Cancel active jobs and return their message UUIDs so lifecycle callers can
   * terminalize the matching persisted prompts instead of leaving hidden
   * `enqueued` rows behind.
   */
  cancelForSessionWithMessages(sessionId: string, queue: string = 'message_delivery'): string[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT json_extract(payload, '$.messageUuid') AS message_uuid
             FROM job_queue
            WHERE queue = ?
              AND json_extract(payload, '$.sessionId') = ?
              AND status IN ('pending', 'processing')`
        )
        .all(queue, sessionId) as Array<{ message_uuid: string | null }>;
      this.db
        .prepare(
          `DELETE FROM job_queue
            WHERE queue = ?
              AND json_extract(payload, '$.sessionId') = ?
              AND status IN ('pending', 'processing')`
        )
        .run(queue, sessionId);
      return rows.flatMap((row) =>
        typeof row.message_uuid === 'string' ? [row.message_uuid] : []
      );
    })();
  }

  /** Cancel one active durable delivery by message UUID. */
  cancelDelivery(sessionId: string, messageUuid: string): boolean {
    return (
      this.db
        .prepare(
          `DELETE FROM job_queue
            WHERE queue = 'message_delivery'
              AND json_extract(payload, '$.sessionId') = ?
              AND json_extract(payload, '$.messageUuid') = ?
              AND status IN ('pending', 'processing')`
        )
        .run(sessionId, messageUuid).changes > 0
    );
  }

  /**
   * The role ('turn' | 'steer') of the active message_delivery job for a UUID,
   * or null if none. Used by {@link deliverMessage}'s idempotency check so a
   * reset-overlap double-persist (the same UUID enqueued by both the old and
   * replacement session, serialized on the per-session lock) does not insert a
   * turn AND a steer for the same prompt. See Codex (#3744886832).
   */
  getActiveDeliveryRole(sessionId: string, messageUuid: string): 'turn' | 'steer' | null {
    const row = this.db
      .prepare(
        `SELECT json_extract(payload, '$.role') AS role
           FROM job_queue
          WHERE queue = 'message_delivery'
            AND json_extract(payload, '$.sessionId') = ?
            AND json_extract(payload, '$.messageUuid') = ?
            AND status IN ('pending', 'processing')
          LIMIT 1`
      )
      .get(sessionId, messageUuid) as { role: string | null } | undefined;
    const role = row?.role;
    return role === 'turn' || role === 'steer' ? role : null;
  }

  /**
   * The set of messageUuids with an ACTIVE (pending/processing) message_delivery
   * job for a session. Used by the LEGACY replay paths
   * (replayPendingMessagesForImmediateMode / handleQueryTrigger /
   * sendEnqueuedMessagesOnTurnEnd) to SKIP messages already owned by a durable
   * v2 job — otherwise, on restart, both the reclaimed v2 job AND the legacy
   * replay would deliver the same message (duplicate). Empty when v2 is off (no
   * message_delivery jobs exist), so legacy behavior is unchanged. See
   * message-delivery-v2.md §10 + Codex review (legacy-replay race).
   */
  activeDeliveryMessageUuids(sessionId: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT json_extract(payload, '$.messageUuid') AS uuid
           FROM job_queue
          WHERE queue = 'message_delivery'
            AND json_extract(payload, '$.sessionId') = ?
            AND status IN ('pending', 'processing')`
      )
      .all(sessionId) as Array<{ uuid: string | null }>;
    const out = new Set<string>();
    for (const r of rows) {
      if (typeof r.uuid === 'string') out.add(r.uuid);
    }
    return out;
  }

  complete(
    jobId: string,
    result?: Record<string, unknown>,
    claimToken?: string | null
  ): Job | null {
    const stmt = this.db.prepare(
      `UPDATE job_queue SET status = 'completed', completed_at = ?, result = ?
        WHERE id = ? AND status = 'processing'
          AND (? IS NULL OR json_extract(payload, '$.__claimToken') = ?)`
    );
    const res = stmt.run(
      Date.now(),
      result !== undefined ? JSON.stringify(result) : null,
      jobId,
      claimToken ?? null,
      claimToken ?? null
    );

    if (res.changes === 0) return null;
    return this.getJob(jobId);
  }

  fail(jobId: string, error: string, claimToken?: string | null): Job | null {
    const row = this.db.prepare(`SELECT * FROM job_queue WHERE id = ?`).get(jobId) as
      | Record<string, unknown>
      | undefined;

    if (!row) return null;
    if (claimToken) {
      const payload = JSON.parse(row.payload as string) as Record<string, unknown>;
      if (row.status !== 'processing' || payload.__claimToken !== claimToken) return null;
    }

    const retryCount = row.retry_count as number;
    const maxRetries = row.max_retries as number;

    if (retryCount < maxRetries) {
      const delay = Math.pow(2, retryCount) * 1000;
      this.db
        .prepare(
          `UPDATE job_queue SET retry_count = retry_count + 1, status = 'pending', error = ?, run_at = ?, started_at = NULL WHERE id = ?`
        )
        .run(error, Date.now() + delay, jobId);
    } else {
      this.db
        .prepare(`UPDATE job_queue SET status = 'dead', error = ?, completed_at = ? WHERE id = ?`)
        .run(error, Date.now(), jobId);
    }

    return this.getJob(jobId);
  }

  getJob(jobId: string): Job | null {
    const stmt = this.db.prepare(`SELECT * FROM job_queue WHERE id = ?`);
    const row = stmt.get(jobId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToJob(row);
  }

  listJobs(filter: { queue?: string; status?: JobStatus | JobStatus[]; limit?: number }): Job[] {
    if (Array.isArray(filter.status) && filter.status.length === 0) {
      return [];
    }

    let query = `SELECT * FROM job_queue WHERE 1=1`;
    const params: (string | number)[] = [];

    if (filter.queue !== undefined) {
      query += ` AND queue = ?`;
      params.push(filter.queue);
    }
    if (filter.status !== undefined) {
      if (Array.isArray(filter.status)) {
        const placeholders = filter.status.map(() => '?').join(',');
        query += ` AND status IN (${placeholders})`;
        params.push(...filter.status);
      } else {
        query += ` AND status = ?`;
        params.push(filter.status);
      }
    }

    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(filter.limit ?? 100);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.rowToJob(r));
  }

  countByStatus(queue: string): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) as count FROM job_queue WHERE queue = ? GROUP BY status`)
      .all(queue) as { status: string; count: number }[];

    const defaults: Record<string, number> = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      dead: 0,
    };

    for (const row of rows) {
      defaults[row.status] = row.count;
    }

    return defaults;
  }

  cleanup(beforeMs: number): number {
    // 'failed' is included defensively: the processor never writes it (retries go back to
    // 'pending' and exhausted retries become 'dead'), but the type contract allows it and
    // future code could produce it. Including it prevents indefinite accumulation.
    const result = this.db
      .prepare(
        `DELETE FROM job_queue WHERE status IN ('completed', 'dead', 'failed') AND completed_at < ?`
      )
      .run(beforeMs);
    return result.changes;
  }

  deleteJob(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM job_queue WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  private findMatchingActiveJob(
    queue: string,
    matchPayload: Record<string, unknown>,
    activeStatuses: JobStatus[] = ['pending', 'processing']
  ): Job | null {
    if (activeStatuses.length === 0) return null;
    const statusPlaceholders = activeStatuses.map(() => '?').join(',');
    const payloadPredicates = Object.values(matchPayload).map((value) =>
      value === null ? `json_type(payload, ?) = 'null'` : `json_extract(payload, ?) = ?`
    );
    const stmt = this.db.prepare(
      `SELECT * FROM job_queue
			 WHERE queue = ?
				 AND status IN (${statusPlaceholders})
				 ${payloadPredicates.length > 0 ? `AND ${payloadPredicates.join(' AND ')}` : ''}
			 ORDER BY created_at DESC
			 LIMIT 1`
    );
    const params: (string | number | null)[] = [queue, ...activeStatuses];
    for (const [key, value] of Object.entries(matchPayload)) {
      params.push(`$.${key}`);
      if (value !== null) params.push(sqliteJsonScalar(value));
    }
    const row = stmt.get(...params) as Record<string, unknown> | undefined;
    return row ? this.rowToJob(row) : null;
  }

  reclaimStale(staleBefore: number): number {
    const result = this.db
      .prepare(
        `UPDATE job_queue SET status = 'pending', started_at = NULL WHERE status = 'processing' AND started_at < ?`
      )
      .run(staleBefore);
    return result.changes;
  }

  private rowToJob(row: Record<string, unknown>): Job {
    const rawPayload = JSON.parse(row.payload as string) as Record<string, unknown>;
    const { ['__claimToken']: _stripped, ...payload } = rawPayload;
    return {
      id: row.id as string,
      queue: row.queue as string,
      status: row.status as JobStatus,
      payload,
      result:
        row.result !== null ? (JSON.parse(row.result as string) as Record<string, unknown>) : null,
      error: (row.error as string | null) ?? null,
      priority: row.priority as number,
      maxRetries: row.max_retries as number,
      retryCount: row.retry_count as number,
      runAt: row.run_at as number,
      createdAt: row.created_at as number,
      startedAt: (row.started_at as number | null) ?? null,
      completedAt: (row.completed_at as number | null) ?? null,
      claimToken: typeof rawPayload.__claimToken === 'string' ? rawPayload.__claimToken : null,
    };
  }
}

function sqliteJsonScalar(value: unknown): string | number | null {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null) return null;
  throw new Error('enqueueUniquePending matchPayload values must be JSON scalar values');
}
