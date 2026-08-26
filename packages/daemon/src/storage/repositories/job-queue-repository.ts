import { generateUUID } from '@hyperneo/shared';
import { withBusyRetry } from '../busy-retry.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

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

export interface ReclaimedJobClaim {
  jobId: string;
  claimToken: string | null;
  queue: string;
  sessionId: string | null;
  messageUuid: string | null;
  role: string | null;
}

export interface PayloadMatch {
  path: string;
  equals: string;
}

export interface FencedDeliveryBatchWriteResult {
  applied: boolean;
  priorBatchUuids: string[] | null;
  priorDroppedBatchUuids: string[];
}

export type DeliveryAdmissionReservation =
  | { status: 'reserved' }
  | { status: 'alreadyReserved'; reservedByClaimToken: string }
  | { status: 'staleClaim' };

function parseUuidArray(value: unknown): string[] | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((uuid): uuid is string => typeof uuid === 'string' && uuid.length > 0);
  } catch {
    return null;
  }
}

const DELIVERY_CLAIM_FENCE_SQL = `queue = 'message_delivery'
  AND json_extract(payload, '$.sessionId') = ?
  AND json_extract(payload, '$.messageUuid') = ?
  AND status = 'processing'
  AND json_extract(payload, '$.__claimToken') = ?`;

export interface JobQueueCandidateSelectionInput {
  queue: string;
  now: number;
  limit: number;
  exclude?: PayloadMatch;
  requireEqual?: PayloadMatch;
  excludeIds?: string[];
}

export interface JobQueueCandidateSelection {
  sql: string;
  params: Array<string | number>;
}

export function buildJobQueueCandidateSelection(
  input: JobQueueCandidateSelectionInput
): JobQueueCandidateSelection {
  let sql = `SELECT * FROM job_queue WHERE queue = ? AND status = 'pending' AND run_at <= ?`;
  const params: Array<string | number> = [input.queue, input.now];
  if (input.requireEqual) {
    sql += ` AND json_extract(payload, ?) = ?`;
    params.push(input.requireEqual.path, input.requireEqual.equals);
  }
  if (input.exclude) {
    sql += ` AND COALESCE(json_extract(payload, ?), '') != ?`;
    params.push(input.exclude.path, input.exclude.equals);
  }
  const excludeIds = input.excludeIds ?? [];
  if (excludeIds.length > 0) {
    sql += ` AND id NOT IN (${excludeIds.map(() => '?').join(',')})`;
    params.push(...excludeIds);
  }
  sql += ` ORDER BY priority DESC, run_at ASC, created_at ASC, rowid ASC LIMIT ?`;
  params.push(input.limit);
  return { sql, params };
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

    withBusyRetry(() =>
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
      )
    );

    return this.getJob(id)!;
  }

  enqueueUniquePending(params: EnqueueUniquePendingParams): Job | null {
    return withBusyRetry(() =>
      this.db.transaction(() => {
        if (this.findMatchingActiveJob(params.queue, params.matchPayload, params.activeStatuses)) {
          return null;
        }
        return this.enqueue(params);
      }, 'immediate')()
    );
  }

  dequeue(queue: string, limit: number = 1, exclude?: PayloadMatch, excludeIds?: string[]): Job[] {
    const claimed: Job[] = [];

    const txn = this.db.transaction(() => {
      const { sql, params } = buildJobQueueCandidateSelection({
        queue,
        now: Date.now(),
        limit,
        exclude,
        excludeIds,
      });
      const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
      this.claimRows(rows, claimed);
    }, 'immediate');

    withBusyRetry(() => txn());
    return claimed;
  }

  dequeueExempt(
    queue: string,
    spec: PayloadMatch,
    limit: number = 1,
    excludeIds?: string[]
  ): Job[] {
    const claimed: Job[] = [];

    const txn = this.db.transaction(() => {
      const { sql, params } = buildJobQueueCandidateSelection({
        queue,
        now: Date.now(),
        limit,
        requireEqual: spec,
        excludeIds,
      });
      const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
      this.claimRows(rows, claimed);
    }, 'immediate');

    withBusyRetry(() => txn());
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

  requeue(jobId: string, runAt: number, claimToken?: string | null): Job | null {
    const stmt = this.db.prepare(
      `UPDATE job_queue SET status = 'pending', run_at = ?, started_at = NULL, heartbeat_at = NULL
        WHERE id = ? AND status = 'processing'
          AND (? IS NULL OR json_extract(payload, '$.__claimToken') = ?)`
    );
    const res = withBusyRetry(() => stmt.run(runAt, jobId, claimToken ?? null, claimToken ?? null));
    if (res.changes === 0) return null;
    return this.getJob(jobId);
  }

  getParkCount(jobId: string): number {
    const row = this.db
      .prepare(`SELECT json_extract(payload, '$.__parkCount') AS c FROM job_queue WHERE id = ?`)
      .get(jobId) as { c: number | null } | undefined;
    return Number(row?.c ?? 0) || 0;
  }

  requeueParked(
    jobId: string,
    runAt: number,
    claimToken?: string | null,
    opts?: { reason?: string }
  ): Job | null {
    const payloadSet =
      opts?.reason !== undefined
        ? `payload = json_set(payload, '$.__parkCount',
               COALESCE(json_extract(payload, '$.__parkCount'), 0) + 1, '$.__parkReason', ?)`
        : `payload = json_set(payload, '$.__parkCount',
               COALESCE(json_extract(payload, '$.__parkCount'), 0) + 1, '$.__parkReason', NULL)`;
    const stmt = this.db.prepare(
      `UPDATE job_queue
         SET status = 'pending', run_at = ?, started_at = NULL, heartbeat_at = NULL,
             ${payloadSet}
       WHERE id = ? AND status = 'processing'
         AND (? IS NULL OR json_extract(payload, '$.__claimToken') = ?)`
    );
    const params =
      opts?.reason !== undefined
        ? [runAt, opts.reason, jobId, claimToken ?? null, claimToken ?? null]
        : [runAt, jobId, claimToken ?? null, claimToken ?? null];
    const res = withBusyRetry(() => stmt.run(...params));
    if (res.changes === 0) return null;
    return this.getJob(jobId);
  }

  requeueAs(
    jobId: string,
    role: string,
    runAt: number,
    claimToken?: string | null,
    opts?: { resetParkCount?: boolean }
  ): Job | null {
    const payloadSet = opts?.resetParkCount
      ? `payload = json_set(payload, '$.role', ?, '$.__parkCount', 0),`
      : `payload = json_set(payload, '$.role', ?),`;
    const stmt = this.db.prepare(
      `UPDATE job_queue
         SET status = 'pending',
             ${payloadSet}
             run_at = ?,
             started_at = NULL,
             heartbeat_at = NULL
       WHERE id = ? AND status = 'processing'
         AND (? IS NULL OR json_extract(payload, '$.__claimToken') = ?)`
    );
    const res = withBusyRetry(() =>
      stmt.run(role, runAt, jobId, claimToken ?? null, claimToken ?? null)
    );
    if (res.changes === 0) return null;
    return this.getJob(jobId);
  }

  rescheduleSessionDeliveries(
    queue: string,
    sessionId: string,
    runAt: number,
    opts?: { parkReason?: string }
  ): number {
    const reasonFilter =
      opts?.parkReason !== undefined ? `AND json_extract(payload, '$.__parkReason') = ?` : '';
    const stmt = this.db.prepare(
      `UPDATE job_queue
          SET run_at = ?, started_at = NULL, heartbeat_at = NULL
        WHERE queue = ? AND status = 'pending'
          AND json_extract(payload, '$.sessionId') = ?
          AND run_at > ?
          ${reasonFilter}`
    );
    const params =
      opts?.parkReason !== undefined
        ? [runAt, queue, sessionId, runAt, opts.parkReason]
        : [runAt, queue, sessionId, runAt];
    const res = withBusyRetry(() => stmt.run(...params));
    return res.changes;
  }

  requeueAllProcessing(queue: string, runAt: number): string[] {
    return withBusyRetry(() =>
      this.db.transaction(() => {
        const rows = this.db
          .prepare(`SELECT id FROM job_queue WHERE queue = ? AND status = 'processing'`)
          .all(queue) as Array<{ id: string }>;
        const requeued: string[] = [];
        for (const row of rows) {
          const res = this.db
            .prepare(
              `UPDATE job_queue SET status = 'pending', run_at = ?, started_at = NULL, heartbeat_at = NULL
                  WHERE id = ? AND status = 'processing'`
            )
            .run(runAt, row.id);
          if (res.changes > 0) requeued.push(row.id);
        }
        return requeued;
      }, 'immediate')()
    );
  }

  reschedulePending(jobId: string, runAt: number): boolean {
    const res = this.db
      .prepare(`UPDATE job_queue SET run_at = ? WHERE id = ? AND status = 'pending'`)
      .run(runAt, jobId);
    return res.changes > 0;
  }

  heartbeat(jobId: string, claimToken: string | null): boolean {
    if (!claimToken) return false;
    const result = withBusyRetry(() =>
      this.db
        .prepare(
          `UPDATE job_queue SET heartbeat_at = ?
            WHERE id = ? AND status = 'processing'
              AND json_extract(payload, '$.__claimToken') = ?`
        )
        .run(Date.now(), jobId, claimToken)
    );
    return result.changes > 0;
  }

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

  cancelForSession(sessionId: string, queue: string = 'message_delivery'): number {
    return this.cancelForSessionWithMessages(sessionId, queue).length;
  }

  cancelForSessionWithMessages(sessionId: string, queue: string = 'message_delivery'): string[] {
    return withBusyRetry(() =>
      this.db.transaction(() => {
        const rows = this.db
          .prepare(
            `SELECT json_extract(payload, '$.messageUuid') AS message_uuid
                 FROM job_queue
                WHERE queue = ?
                  AND json_extract(payload, '$.sessionId') = ?
                  AND status IN ('pending', 'processing')`
          )
          .all(queue, sessionId) as Array<{ message_uuid: string | null }>;
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
      }, 'immediate')()
    );
  }

  cancelDelivery(sessionId: string, messageUuid: string): boolean {
    const result = withBusyRetry(() =>
      this.db
        .prepare(
          `DELETE FROM job_queue
            WHERE queue = 'message_delivery'
              AND json_extract(payload, '$.sessionId') = ?
              AND json_extract(payload, '$.messageUuid') = ?
              AND status IN ('pending', 'processing')`
        )
        .run(sessionId, messageUuid)
    );
    return result.changes > 0;
  }

  getActiveDeliveryRole(sessionId: string, messageUuid: string): 'turn' | 'steer' | null {
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

  narrowActiveDeliveryBatchUuids(
    sessionId: string,
    kickoffUuid: string,
    admitted: string[]
  ): boolean {
    const current = this.getActiveDeliveryBatchUuids(sessionId, kickoffUuid);
    if (!current) return false;
    const admittedSet = new Set(admitted);
    const dropped = current.filter((uuid) => !admittedSet.has(uuid));
    const settleableDropped =
      dropped.length > 0 ? this.settleableBatchMembers(sessionId, dropped) : [];
    const res = withBusyRetry(() =>
      this.db
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
        .run(JSON.stringify(admitted), JSON.stringify(settleableDropped), sessionId, kickoffUuid)
    );
    return res.changes > 0;
  }

  updateDeliveryBatchUuidsFenced(args: {
    sessionId: string;
    kickoffUuid: string;
    claimToken: string;
    expectedBatchUuids: string[];
    batchUuids: string[];
    droppedBatchUuids?: string[];
  }): FencedDeliveryBatchWriteResult {
    const prior = this.db
      .prepare(
        `SELECT json_extract(payload, '$.batchUuids') AS batch,
                json_extract(payload, '$.droppedBatchUuids') AS dropped
           FROM job_queue
          WHERE ${DELIVERY_CLAIM_FENCE_SQL}`
      )
      .get(args.sessionId, args.kickoffUuid, args.claimToken) as
      | { batch: string | null; dropped: string | null }
      | undefined;
    const priorBatchUuids = prior ? parseUuidArray(prior.batch) : null;
    const priorDroppedBatchUuids = parseUuidArray(prior?.dropped) ?? [];
    if (priorBatchUuids === null) {
      return { applied: false, priorBatchUuids: null, priorDroppedBatchUuids: [] };
    }
    const dropped = priorBatchUuids.filter((uuid) => !args.batchUuids.includes(uuid));
    const droppedBatchUuids =
      args.droppedBatchUuids ??
      (dropped.length > 0 ? this.settleableBatchMembers(args.sessionId, dropped) : []);
    const res = withBusyRetry(() =>
      this.db
        .prepare(
          `UPDATE job_queue
              SET payload = json_set(
                    json_set(payload, '$.batchUuids', json(?)),
                    '$.droppedBatchUuids', json(?)
                  )
            WHERE ${DELIVERY_CLAIM_FENCE_SQL}
              AND json_extract(payload, '$.batchUuids') = json(?)`
        )
        .run(
          JSON.stringify(args.batchUuids),
          JSON.stringify(droppedBatchUuids),
          args.sessionId,
          args.kickoffUuid,
          args.claimToken,
          JSON.stringify(args.expectedBatchUuids)
        )
    );
    return { applied: res.changes > 0, priorBatchUuids, priorDroppedBatchUuids };
  }

  transitionDeliverySendStatusFenced(args: {
    sessionId: string;
    kickoffUuid: string;
    claimToken: string;
    uuids: string[];
    fromStatus: 'enqueued' | 'submitted';
    toStatus: 'submitted' | 'enqueued';
  }): string[] {
    if (args.uuids.length === 0) return [];
    const placeholders = args.uuids.map(() => '?').join(',');
    const rows = withBusyRetry(
      () =>
        this.db
          .prepare(
            `UPDATE sdk_messages
              SET send_status = ?
            WHERE session_id = ?
              AND message_type = 'user'
              AND sdk_uuid IN (${placeholders})
              AND send_status = ?
              AND EXISTS (
                SELECT 1 FROM job_queue
                 WHERE ${DELIVERY_CLAIM_FENCE_SQL}
              )
            RETURNING sdk_uuid`
          )
          .all(
            args.toStatus,
            args.sessionId,
            ...args.uuids,
            args.fromStatus,
            args.sessionId,
            args.kickoffUuid,
            args.claimToken
          ) as Array<{ sdk_uuid: string }>
    );
    return rows.map((row) => row.sdk_uuid);
  }

  reserveDeliveryAdmission(args: {
    sessionId: string;
    kickoffUuid: string;
    claimToken: string;
    messageUuid: string;
  }): DeliveryAdmissionReservation {
    const reservationPath = `$.__admissionReservations."${args.messageUuid}"`;
    const res = withBusyRetry(() =>
      this.db
        .prepare(
          `UPDATE job_queue
              SET payload = json_set(payload, ?, json(?))
            WHERE ${DELIVERY_CLAIM_FENCE_SQL}
              AND json_extract(payload, ?) IS NULL`
        )
        .run(
          reservationPath,
          JSON.stringify(args.claimToken),
          args.sessionId,
          args.kickoffUuid,
          args.claimToken,
          reservationPath
        )
    );
    if (res.changes > 0) return { status: 'reserved' };
    const row = this.db
      .prepare(
        `SELECT json_extract(payload, ?) AS reservedBy
           FROM job_queue
          WHERE ${DELIVERY_CLAIM_FENCE_SQL}`
      )
      .get(reservationPath, args.sessionId, args.kickoffUuid, args.claimToken) as
      | { reservedBy: string | null }
      | undefined;
    if (!row || typeof row.reservedBy !== 'string') return { status: 'staleClaim' };
    return { status: 'alreadyReserved', reservedByClaimToken: row.reservedBy };
  }

  settleableBatchMembers(sessionId: string, uuids: string[]): string[] {
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

  hasActiveTurnDeliveryJob(sessionId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1
           FROM job_queue
          WHERE queue = 'message_delivery'
            AND json_extract(payload, '$.sessionId') = ?
            AND json_extract(payload, '$.role') = 'turn'
            AND status IN ('pending', 'processing')
          LIMIT 1`
      )
      .get(sessionId) as { 1: number } | undefined | null;
    return row != null;
  }

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
    const res = withBusyRetry(() =>
      stmt.run(
        Date.now(),
        result !== undefined ? JSON.stringify(result) : null,
        jobId,
        claimToken ?? null,
        claimToken ?? null
      )
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
      result = withBusyRetry(() =>
        this.db
          .prepare(
            `UPDATE job_queue
                SET retry_count = retry_count + 1, status = 'pending', error = ?,
                    run_at = ?, started_at = NULL, heartbeat_at = NULL
              WHERE id = ?
                AND (? IS NULL OR (status = 'processing'
                  AND json_extract(payload, '$.__claimToken') = ?))`
          )
          .run(error, Date.now() + delay, jobId, claimToken ?? null, claimToken ?? null)
      );
    } else {
      result = withBusyRetry(() =>
        this.db
          .prepare(
            `UPDATE job_queue SET status = 'dead', error = ?, completed_at = ?, heartbeat_at = NULL
              WHERE id = ?
                AND (? IS NULL OR (status = 'processing'
                  AND json_extract(payload, '$.__claimToken') = ?))`
          )
          .run(error, Date.now(), jobId, claimToken ?? null, claimToken ?? null)
      );
    }

    return result.changes > 0 ? this.getJob(jobId) : null;
  }

  markDead(jobId: string, error: string, claimToken?: string | null): Job | null {
    const row = this.db.prepare(`SELECT * FROM job_queue WHERE id = ?`).get(jobId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    if (claimToken) {
      const payload = JSON.parse(row.payload as string) as Record<string, unknown>;
      if (row.status !== 'processing' || payload.__claimToken !== claimToken) return null;
    }
    const result = withBusyRetry(() =>
      this.db
        .prepare(
          `UPDATE job_queue SET status = 'dead', error = ?, completed_at = ?, heartbeat_at = NULL
            WHERE id = ?
              AND (? IS NULL OR (status = 'processing'
                AND json_extract(payload, '$.__claimToken') = ?))`
        )
        .run(error, Date.now(), jobId, claimToken ?? null, claimToken ?? null)
    );
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
    const result = this.db
      .prepare(
        `DELETE FROM job_queue WHERE status IN ('completed', 'dead', 'failed') AND completed_at < ?`
      )
      .run(beforeMs);
    return result.changes;
  }

  cleanupCompleted(queue: string, beforeMs: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM job_queue WHERE queue = ? AND status = 'completed' AND completed_at < ?`
      )
      .run(queue, beforeMs);
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

  reclaimStale(staleBefore: number, queues?: string[]): ReclaimedJobClaim[] {
    return withBusyRetry(() =>
      this.db.transaction(() => {
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
      }, 'immediate')()
    );
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
