import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';

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

  dequeue(queue: string, limit: number = 1): Job[] {
    const claimed: Job[] = [];

    const txn = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM job_queue WHERE queue = ? AND status = 'pending' AND run_at <= ? ORDER BY priority DESC, run_at ASC LIMIT ?`
        )
        .all(queue, Date.now(), limit) as Record<string, unknown>[];

      const now = Date.now();
      for (const row of rows) {
        this.db
          .prepare(`UPDATE job_queue SET status = 'processing', started_at = ? WHERE id = ?`)
          .run(now, row.id as string);
        claimed.push(this.getJob(row.id as string)!);
      }
    });

    txn();
    return claimed;
  }

  complete(jobId: string, result?: Record<string, unknown>): Job | null {
    const stmt = this.db.prepare(
      `UPDATE job_queue SET status = 'completed', completed_at = ?, result = ? WHERE id = ? AND status = 'processing'`
    );
    const res = stmt.run(Date.now(), result !== undefined ? JSON.stringify(result) : null, jobId);

    if (res.changes === 0) return null;
    return this.getJob(jobId);
  }

  fail(jobId: string, error: string): Job | null {
    const row = this.db.prepare(`SELECT * FROM job_queue WHERE id = ?`).get(jobId) as
      | Record<string, unknown>
      | undefined;

    if (!row) return null;

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
    return {
      id: row.id as string,
      queue: row.queue as string,
      status: row.status as JobStatus,
      payload: JSON.parse(row.payload as string) as Record<string, unknown>,
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
    };
  }
}

function sqliteJsonScalar(value: unknown): string | number | null {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null) return null;
  throw new Error('enqueueUniquePending matchPayload values must be JSON scalar values');
}
