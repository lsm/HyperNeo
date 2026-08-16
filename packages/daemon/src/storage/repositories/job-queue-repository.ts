import { generateUUID } from '@hyperneo/shared';
import type { Database as BunDatabase } from '../sqlite-compat';

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
  heartbeatAt: number | null;
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
export interface ReclaimedJobClaim {
  jobId: string;
  claimToken: string | null;
  queue: string;
  sessionId: string | null;
  messageUuid: string | null;
  role: string | null;
}

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
      `INSERT INTO job_queue (id, queue, status, payload, result, error, priority, max_retries, retry_count, run_at, created_at, started_at, heartbeat_at, completed_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

  dequeue(queue: string, limit: number = 1, exclude?: PayloadMatch, excludeIds?: string[]): Job[] {
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
      if (excludeIds && excludeIds.length > 0) {
        // Leave just-reclaimed jobs whose aborting handler has not settled yet —
        // claiming them now would overlap the predecessor attempt.
        sql += ` AND id NOT IN (${excludeIds.map(() => '?').join(',')})`;
        params.push(...excludeIds);
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
  dequeueExempt(
    queue: string,
    spec: PayloadMatch,
    limit: number = 1,
    excludeIds?: string[]
  ): Job[] {
    const claimed: Job[] = [];

    const txn = this.db.transaction(() => {
      let sql = `SELECT * FROM job_queue
             WHERE queue = ? AND status = 'pending' AND run_at <= ?
               AND json_extract(payload, ?) = ?`;
      const params: (string | number)[] = [queue, Date.now(), spec.path, spec.equals];
      if (excludeIds && excludeIds.length > 0) {
        // Same settling-predecessor exclusion as dequeue().
        sql += ` AND id NOT IN (${excludeIds.map(() => '?').join(',')})`;
        params.push(...excludeIds);
      }
      sql += ` ORDER BY priority DESC, run_at ASC, created_at ASC, rowid ASC LIMIT ?`;
      params.push(limit);
      const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
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
              SET status = 'processing', started_at = ?, heartbeat_at = ?,
                  payload = json_set(payload, '$.__claimToken', ?)
            WHERE id = ? AND status = 'pending'`
        )
        .run(now, now, claimToken, row.id as string);
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
      `UPDATE job_queue SET status = 'pending', run_at = ?, started_at = NULL, heartbeat_at = NULL
        WHERE id = ? AND status = 'processing'
          AND (? IS NULL OR json_extract(payload, '$.__claimToken') = ?)`
    );
    const res = stmt.run(runAt, jobId, claimToken ?? null, claimToken ?? null);
    if (res.changes === 0) return null;
    return this.getJob(jobId);
  }

  /**
   * Read a steer job's accumulated park count (stored in the payload as
   * `__parkCount` by {@link requeueParked}). 0 when unset (fresh job / non-steer).
   * Used by the message-delivery handler to bound how long a steer parks before
   * dead-lettering (its owning turn may be blocked on `sdk_resume_choice`).
   */
  getParkCount(jobId: string): number {
    const row = this.db
      .prepare(`SELECT json_extract(payload, '$.__parkCount') AS c FROM job_queue WHERE id = ?`)
      .get(jobId) as { c: number | null } | undefined;
    return Number(row?.c ?? 0) || 0;
  }

  /**
   * Like {@link requeue} but bumps the payload's `__parkCount` (used to bound
   * steer parking — see {@link getParkCount}). No retry_count bump (parking is a
   * wait, not a failure). The processor's auto-`complete()` on handler return is
   * a no-op (the row is no longer `processing`).
   */
  requeueParked(jobId: string, runAt: number, claimToken?: string | null): Job | null {
    const stmt = this.db.prepare(
      `UPDATE job_queue
         SET status = 'pending', run_at = ?, started_at = NULL, heartbeat_at = NULL,
             payload = json_set(payload, '$.__parkCount',
               COALESCE(json_extract(payload, '$.__parkCount'), 0) + 1)
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
  requeueAs(jobId: string, role: string, runAt: number, claimToken?: string | null): Job | null {
    const res = this.db
      .prepare(
        `UPDATE job_queue
           SET status = 'pending',
               payload = json_set(payload, '$.role', ?),
               run_at = ?,
               started_at = NULL,
               heartbeat_at = NULL
         WHERE id = ? AND status = 'processing'
           AND (? IS NULL OR json_extract(payload, '$.__claimToken') = ?)`
      )
      .run(role, runAt, jobId, claimToken ?? null, claimToken ?? null);
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
        `UPDATE job_queue SET status = 'pending', run_at = ?, started_at = NULL, heartbeat_at = NULL WHERE queue = ? AND status = 'processing'`
      )
      .run(runAt, queue);
    return res.changes;
  }

  /** Renew the lease for one exact processing claim without changing its start time. */
  heartbeat(jobId: string, claimToken: string | null): boolean {
    if (!claimToken) return false;
    const result = this.db
      .prepare(
        `UPDATE job_queue SET heartbeat_at = ?
          WHERE id = ? AND status = 'processing'
            AND json_extract(payload, '$.__claimToken') = ?`
      )
      .run(Date.now(), jobId, claimToken);
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

  /** True when another processing generation now owns this job row. */
  isClaimOwnedByAnother(jobId: string, claimToken: string | null): boolean {
    if (!claimToken) return false;
    return !!this.db
      .prepare(
        `SELECT 1 FROM job_queue
          WHERE id = ? AND status = 'processing'
            AND json_extract(payload, '$.__claimToken') != ?`
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
   * `enqueued` rows behind. Batch-aware: members of a coalesced turn's
   * `batchUuids` are included (they own no job row, but their prompts are as
   * undelivered as the kickoff's).
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
      // Batch members (batchUuids) plus the over-budget/removed tail preserved
      // at narrowing time (droppedBatchUuids): all three groups need their
      // rows terminalized when the session's deliveries are cancelled — the
      // dropped tail lost its job ownership but would otherwise linger
      // `enqueued` in a session that never reconciles again (archive/reset).
      const batchRows = this.db
        .prepare(
          `SELECT je.value AS message_uuid
             FROM job_queue, json_each(
                  CASE WHEN json_type(payload, '$.batchUuids') = 'array'
                       THEN json_extract(payload, '$.batchUuids') ELSE '[]' END
                ) AS je
            WHERE queue = ?
              AND json_extract(payload, '$.sessionId') = ?
              AND status IN ('pending', 'processing')
            UNION
            SELECT jd.value AS message_uuid
             FROM job_queue, json_each(
                  CASE WHEN json_type(payload, '$.droppedBatchUuids') = 'array'
                       THEN json_extract(payload, '$.droppedBatchUuids') ELSE '[]' END
                ) AS jd
            WHERE queue = ?
              AND json_extract(payload, '$.sessionId') = ?
              AND status IN ('pending', 'processing')`
        )
        .all(queue, sessionId, queue, sessionId) as Array<{ message_uuid: string | null }>;
      this.db
        .prepare(
          `DELETE FROM job_queue
            WHERE queue = ?
              AND json_extract(payload, '$.sessionId') = ?
              AND status IN ('pending', 'processing')`
        )
        .run(queue, sessionId);
      return [...rows, ...batchRows].flatMap((row) =>
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
    // Batch-aware: a member of an active batched turn (payload.batchUuids)
    // owns no job row of its own — without the EXISTS clause, a promote RPC
    // (Move to Steer) on such a member would insert an individual steer on
    // top of the pending combined prompt and deliver it twice.
    const row = this.db
      .prepare(
        `SELECT json_extract(payload, '$.role') AS role
           FROM job_queue
          WHERE queue = 'message_delivery'
            AND json_extract(payload, '$.sessionId') = ?
            AND status IN ('pending', 'processing')
            AND (
              json_extract(payload, '$.messageUuid') = ?
              OR EXISTS (
                SELECT 1 FROM json_each(
                  CASE WHEN json_type(payload, '$.batchUuids') = 'array'
                       THEN json_extract(payload, '$.batchUuids') ELSE '[]' END
                ) AS je WHERE je.value = ?
              )
            )
          LIMIT 1`
      )
      .get(sessionId, messageUuid, messageUuid) as { role: string | null } | undefined;
    const role = row?.role;
    return role === 'turn' || role === 'steer' ? role : null;
  }

  /**
   * The `batchUuids` of the active (pending/processing) message_delivery job
   * whose kickoff is `kickoffUuid`, or null when none. Used by the ACP
   * acceptance path (SdkMessageHandler.markMessageAccepted) to consume a
   * batched flush's members together with the kickoff — the membership lives
   * in the durable payload, so a crash + reclaim between admission and
   * acceptance still resolves the same batch.
   */
  getActiveDeliveryBatchUuids(sessionId: string, kickoffUuid: string): string[] | null {
    const row = this.db
      .prepare(
        `SELECT json_extract(payload, '$.batchUuids') AS batch
           FROM job_queue
          WHERE queue = 'message_delivery'
            AND json_extract(payload, '$.sessionId') = ?
            AND json_extract(payload, '$.messageUuid') = ?
            AND json_type(payload, '$.batchUuids') = 'array'
            AND status IN ('pending', 'processing')
          ORDER BY created_at DESC LIMIT 1`
      )
      .get(sessionId, kickoffUuid) as { batch: string | null } | undefined;
    if (typeof row?.batch !== 'string') return null;
    try {
      const parsed = JSON.parse(row.batch) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((u): u is string => typeof u === 'string')
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Narrow an active batched-turn job's `batchUuids` payload to the members
   * ACTUALLY admitted into the prompt (the bridge revalidates under its lock
   * and drops members removed/deferred/over-budget since enqueue). Every
   * payload consumer — the ACP acceptance consume, dead-letter settlement,
   * and the batch-aware active lookups — then operates on exactly what was
   * fed, so never-admitted tails are neither marked consumed, nor failed, nor
   * shielded from redelivery. The dropped tail is preserved separately as
   * `droppedBatchUuids` so lifecycle cancellation
   * ({@link cancelForSessionWithMessages}) can still settle those rows — they
   * lost their job ownership but not their need for terminalization when the
   * session is archived/reset mid-batch. Returns true when a row was updated.
   */
  narrowActiveDeliveryBatchUuids(
    sessionId: string,
    kickoffUuid: string,
    admitted: string[]
  ): boolean {
    const current = this.getActiveDeliveryBatchUuids(sessionId, kickoffUuid);
    if (!current) return false;
    const admittedSet = new Set(admitted);
    const dropped = current.filter((uuid) => !admittedSet.has(uuid));
    // Only record drops that still need lifecycle settlement: rows currently
    // `enqueued`/`submitted`. A user-deferred or failed member is in its
    // user-intended state — including it would let a later archive/reset
    // cancellation (which fails everything it is handed) terminalize the
    // user's deliberately-queued message.
    const settleableDropped =
      dropped.length > 0 ? this.settleableBatchMembers(sessionId, dropped) : [];
    // json(?) parses the bound text INTO a JSON array — binding it directly
    // would store a string value and break the json_type(...)= 'array' guards.
    const res = this.db
      .prepare(
        `UPDATE job_queue
            SET payload = json_set(
                  json_set(payload, '$.batchUuids', json(?)),
                  '$.droppedBatchUuids', json(?)
                )
          WHERE queue = 'message_delivery'
            AND json_extract(payload, '$.sessionId') = ?
            AND json_extract(payload, '$.messageUuid') = ?
            AND status IN ('pending', 'processing')`
      )
      .run(JSON.stringify(admitted), JSON.stringify(settleableDropped), sessionId, kickoffUuid);
    return res.changes > 0;
  }

  /**
   * The subset of `uuids` whose sdk_messages rows are still pending delivery
   * (`enqueued`/`submitted`) — the only members lifecycle cancellation needs
   * to settle. User-deferred/failed/removed rows keep their own state.
   */
  private settleableBatchMembers(sessionId: string, uuids: string[]): string[] {
    const placeholders = uuids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT sdk_uuid AS uuid FROM sdk_messages
          WHERE session_id = ? AND sdk_uuid IN (${placeholders})
            AND send_status IN ('enqueued', 'submitted')`
      )
      .all(sessionId, ...uuids) as Array<{ uuid: string }>;
    return rows.map((r) => r.uuid);
  }

  /**
   * True when a `message_delivery` job for (sessionId, messageUuid) is
   * currently `processing` — a turn the handler is actively driving. The
   * terminal-idle turn-end marker gate uses this to distinguish "the delivery
   * turn ended" from "a graceful-shutdown requeue already flipped the job to
   * `pending` (resume desired on next boot)". See Codex (PR #2463, P2).
   */
  isProcessingDelivery(sessionId: string, messageUuid: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1
           FROM job_queue
          WHERE queue = 'message_delivery'
            AND status = 'processing'
            AND json_extract(payload, '$.sessionId') = ?
            AND json_extract(payload, '$.messageUuid') = ?
          LIMIT 1`
      )
      .get(sessionId, messageUuid) as { 1: number } | undefined | null;
    return row != null;
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
   *
   * Batch-aware: UUIDs listed in an active job's `batchUuids` (queue-flush
   * coalesced turns) are included — they own no job row of their own, so
   * without this the orphan reconciler / legacy replays would re-enqueue the
   * members individually and duplicate the batched prompt.
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
    // Members of batched turns (payload.batchUuids arrays). The CASE guard
    // keeps json_each from erroring on payloads without a batchUuids array.
    const batchRows = this.db
      .prepare(
        `SELECT je.value AS uuid
           FROM job_queue, json_each(
                CASE WHEN json_type(payload, '$.batchUuids') = 'array'
                     THEN json_extract(payload, '$.batchUuids') ELSE '[]' END
              ) AS je
          WHERE queue = 'message_delivery'
            AND json_extract(payload, '$.sessionId') = ?
            AND status IN ('pending', 'processing')`
      )
      .all(sessionId) as Array<{ uuid: string | null }>;
    for (const r of batchRows) {
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
      `UPDATE job_queue SET status = 'completed', completed_at = ?, result = ?, heartbeat_at = NULL
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

    let result: { changes: number };
    if (retryCount < maxRetries) {
      const delay = 2 ** retryCount * 1000;
      result = this.db
        .prepare(
          `UPDATE job_queue
              SET retry_count = retry_count + 1, status = 'pending', error = ?,
                  run_at = ?, started_at = NULL, heartbeat_at = NULL
            WHERE id = ?
              AND (? IS NULL OR (status = 'processing'
                AND json_extract(payload, '$.__claimToken') = ?))`
        )
        .run(error, Date.now() + delay, jobId, claimToken ?? null, claimToken ?? null);
    } else {
      result = this.db
        .prepare(
          `UPDATE job_queue SET status = 'dead', error = ?, completed_at = ?, heartbeat_at = NULL
            WHERE id = ?
              AND (? IS NULL OR (status = 'processing'
                AND json_extract(payload, '$.__claimToken') = ?))`
        )
        .run(error, Date.now(), jobId, claimToken ?? null, claimToken ?? null);
    }

    return result.changes > 0 ? this.getJob(jobId) : null;
  }

  /**
   * Force a claimed job straight to `dead`, bypassing the retry budget. Used
   * when a handler throws `DeadLetterImmediatelyError` (e.g. a delivery turn
   * that ended in a non-recoverable error — auth/permission/quota — where
   * retrying won't help). Mirrors `fail`'s terminal branch but skips the
   * retry-count check. Returns the dead row (or null if the claim was lost).
   */
  markDead(jobId: string, error: string, claimToken?: string | null): Job | null {
    const row = this.db.prepare(`SELECT * FROM job_queue WHERE id = ?`).get(jobId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    if (claimToken) {
      const payload = JSON.parse(row.payload as string) as Record<string, unknown>;
      if (row.status !== 'processing' || payload.__claimToken !== claimToken) return null;
    }
    const result = this.db
      .prepare(
        `UPDATE job_queue SET status = 'dead', error = ?, completed_at = ?, heartbeat_at = NULL
          WHERE id = ?
            AND (? IS NULL OR (status = 'processing'
              AND json_extract(payload, '$.__claimToken') = ?))`
      )
      .run(error, Date.now(), jobId, claimToken ?? null, claimToken ?? null);
    return result.changes > 0 ? this.getJob(jobId) : null;
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

  /**
   * Count `processing` rows in a lane whose effective lease (`heartbeat_at`, falling back to `started_at`) is past the
   * stale-reclamation threshold — i.e. reclaimable (their handler stopped
   * heartbeating). Used by the messageDelivery.diagnostics RPC to distinguish
   * genuinely-stale deliveries from healthy in-flight turns (which `countByStatus`
   * groups together). Indexed by `idx_job_queue_status`. (task #861, review.)
   */
  countStaleProcessing(queue: string, staleBeforeMs: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM job_queue
           WHERE queue = ? AND status = 'processing'
             AND COALESCE(heartbeat_at, started_at) IS NOT NULL
             AND COALESCE(heartbeat_at, started_at) < ?`
      )
      .get(queue, staleBeforeMs) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  oldestProcessingLeaseAgeMs(queue: string, nowMs = Date.now()): number | null {
    const row = this.db
      .prepare(
        `SELECT MIN(COALESCE(heartbeat_at, started_at)) AS oldest
           FROM job_queue
          WHERE queue = ? AND status = 'processing'`
      )
      .get(queue) as { oldest: number | null } | undefined;
    return row?.oldest == null ? null : Math.max(0, nowMs - row.oldest);
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

  /**
   * Reclaim stale `processing` rows back to `pending`. When `queues` is given,
   * only rows in those lanes are reclaimed — a `JobQueueProcessor` passes the
   * queues it registered so it only reclaims claims whose in-flight handler it
   * can actually cancel; the delivery and general processors share one
   * repository but must not sweep each other's lanes (the non-owner cannot
   * abort the old handler, so its still-live turn would overlap the replacement
   * claim). `undefined` reclaims every queue; an empty array reclaims nothing.
   */
  reclaimStale(staleBefore: number, queues?: string[]): ReclaimedJobClaim[] {
    return this.db.transaction(() => {
      let candidateSql = `SELECT id, queue,
                  json_extract(payload, '$.__claimToken') AS claim_token,
                  json_extract(payload, '$.sessionId') AS session_id,
                  json_extract(payload, '$.messageUuid') AS message_uuid,
                  json_extract(payload, '$.role') AS role
             FROM job_queue
            WHERE status = 'processing' AND COALESCE(heartbeat_at, started_at) < ?`;
      const candidateParams: (string | number | null)[] = [staleBefore];
      if (queues) {
        candidateSql += ` AND queue IN (${queues.map(() => '?').join(',')})`;
        candidateParams.push(...queues);
      }
      const candidates = this.db.prepare(candidateSql).all(...candidateParams) as Array<{
        id: string;
        queue: string;
        claim_token: string | null;
        session_id: string | null;
        message_uuid: string | null;
        role: string | null;
      }>;
      const reclaimed: ReclaimedJobClaim[] = [];

      for (const candidate of candidates) {
        const result = this.db
          .prepare(
            `UPDATE job_queue
                SET status = 'pending', started_at = NULL, heartbeat_at = NULL
              WHERE id = ? AND status = 'processing'
                AND COALESCE(heartbeat_at, started_at) < ?
                AND ((? IS NULL AND json_extract(payload, '$.__claimToken') IS NULL)
                  OR json_extract(payload, '$.__claimToken') = ?)`
          )
          .run(candidate.id, staleBefore, candidate.claim_token, candidate.claim_token);
        if (result.changes > 0) {
          reclaimed.push({
            jobId: candidate.id,
            claimToken: candidate.claim_token,
            queue: candidate.queue,
            sessionId: candidate.session_id,
            messageUuid: candidate.message_uuid,
            role: candidate.role,
          });
        }
      }

      return reclaimed;
    })();
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
      heartbeatAt: (row.heartbeat_at as number | null) ?? null,
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
