import type { HookFlow, HookStateSnapshot } from '@hyperneo/shared';
import type { Database as BunDatabase } from '../sqlite-compat';

interface HookStateRow {
  run_id: string;
  hook_id: string;
  version: number;
  local_state: string;
  last_flow: string | null;
  last_reason: string | null;
  retry_count: number;
  next_retry_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * Patch applied under an optimistic-version guard. Each field is optional; the
 * repo merges `localState` deeply and replaces the scalar fields.
 */
export interface WorkflowHookStatePatch {
  expectedVersion: number;
  localState?: Record<string, unknown>;
  lastFlow?: HookFlow;
  lastReason?: string;
  retryCount?: number;
  nextRetryAt?: number | null;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainRecord(value) && isPlainRecord(next[key])) {
      next[key] = deepMerge(next[key] as Record<string, unknown>, value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function rowToSnapshot(row: HookStateRow): HookStateSnapshot {
  return {
    runId: row.run_id,
    hookId: row.hook_id,
    version: row.version,
    localState: parseJson(row.local_state, {}),
    // `last_flow` is stored as a raw enum string ('continue'|'stop'|'retry'),
    // NOT JSON — read it directly (parseJson would reject the unquoted token).
    lastFlow: (row.last_flow ?? undefined) as HookFlow | undefined,
    lastReason: row.last_reason ?? undefined,
    retryCount: row.retry_count,
    nextRetryAt: row.next_retry_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WorkflowHookStateRepository {
  constructor(private db: BunDatabase) {}

  get(runId: string, hookId: string): HookStateSnapshot | null {
    const row = this.db
      .prepare(`SELECT * FROM workflow_hook_state WHERE run_id = ? AND hook_id = ?`)
      .get(runId, hookId) as HookStateRow | undefined;
    return row ? rowToSnapshot(row) : null;
  }

  ensure(runId: string, hookId: string, defaults: Record<string, unknown> = {}): HookStateSnapshot {
    const existing = this.get(runId, hookId);
    if (existing) return existing;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO workflow_hook_state
          (run_id, hook_id, version, local_state, last_flow, last_reason, retry_count, next_retry_at, created_at, updated_at)
         VALUES (?, ?, 0, ?, NULL, NULL, 0, NULL, ?, ?)`
      )
      .run(runId, hookId, JSON.stringify(defaults), now, now);
    return this.get(runId, hookId)!;
  }

  listByRun(runId: string): HookStateSnapshot[] {
    const rows = this.db
      .prepare(`SELECT * FROM workflow_hook_state WHERE run_id = ?`)
      .all(runId) as HookStateRow[];
    return rows.map(rowToSnapshot);
  }

  update(runId: string, hookId: string, patch: WorkflowHookStatePatch): HookStateSnapshot | null {
    const tx = this.db.transaction(() => {
      let current = this.get(runId, hookId);
      if (!current) {
        if (patch.expectedVersion !== 0) return null;
        current = this.ensure(runId, hookId);
      }
      if (current.version !== patch.expectedVersion) return null;
      const now = Date.now();
      const nextVersion = current.version + 1;
      const nextLocalState = patch.localState
        ? deepMerge(current.localState, patch.localState)
        : current.localState;
      const nextRetryCount = patch.retryCount ?? current.retryCount;
      const nextRetryAt =
        patch.nextRetryAt === undefined ? (current.nextRetryAt ?? null) : patch.nextRetryAt;
      const nextLastFlow = patch.lastFlow ?? current.lastFlow;
      const nextLastReason = patch.lastReason !== undefined ? patch.lastReason : current.lastReason;

      const result = this.db
        .prepare(
          `UPDATE workflow_hook_state
           SET version = ?, local_state = ?, last_flow = ?, last_reason = ?, retry_count = ?, next_retry_at = ?, updated_at = ?
           WHERE run_id = ? AND hook_id = ? AND version = ?`
        )
        .run(
          nextVersion,
          JSON.stringify(nextLocalState),
          nextLastFlow ?? null,
          nextLastReason ?? null,
          nextRetryCount,
          nextRetryAt,
          now,
          runId,
          hookId,
          patch.expectedVersion
        );
      if (result.changes === 0) return null;
      return this.get(runId, hookId);
    });
    return tx();
  }
}
