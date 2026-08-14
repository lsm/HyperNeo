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
  /**
   * Key paths to DELETE from localState after the merge, outermost key first
   * (e.g. `['__queuedRetryableActions', actionKey]`). Deep-merge preserves
   * keys the patch omits, so a caller clearing an entry must name it here —
   * physically removing the key (bounded growth, no tombstones) while staying
   * merge-safe: sibling keys written before or after the delete survive
   * either order. `localState` itself keeps plain merge semantics, so a null
   * RECORDED by a hook via recordState(key, null) is stored, not deleted.
   */
  localStateDeletePaths?: string[][];
  lastFlow?: HookFlow;
  /** `null` explicitly clears the reason (an absent `reason` keeps the current one). */
  lastReason?: string | null;
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

/** Delete each key path from `state` (after the deep-merge), skipping absent paths. */
function deletePaths(state: Record<string, unknown>, paths: string[][]): void {
  for (const path of paths) {
    if (path.length === 0) continue;
    let cursor: Record<string, unknown> | undefined = state;
    for (let i = 0; i < path.length - 1 && cursor; i++) {
      const next: unknown = cursor[path[i]];
      cursor = isPlainRecord(next) ? next : undefined;
    }
    if (cursor) delete cursor[path[path.length - 1]];
  }
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

  /**
   * Optimistic-version update with a bounded retry loop (the caller's
   * `expectedVersion` is refreshed from the current row each attempt), so a
   * concurrent writer bumping the version does not surface as a conflict to
   * callers like the retryHook/approveHook RPCs. Returns the updated snapshot,
   * or null when every attempt conflicted/erred.
   */
  updateWithRetry(
    runId: string,
    hookId: string,
    patch: Omit<WorkflowHookStatePatch, 'expectedVersion'>
  ): HookStateSnapshot | null {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const current = this.get(runId, hookId) ?? this.ensure(runId, hookId);
        const result = this.update(runId, hookId, { ...patch, expectedVersion: current.version });
        if (result) return result;
      } catch {
        // retry on version conflict or transient repo error
      }
    }
    return null;
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
      const mergedLocalState = patch.localState
        ? deepMerge(current.localState, patch.localState)
        : { ...current.localState };
      if (patch.localStateDeletePaths?.length) {
        deletePaths(mergedLocalState, patch.localStateDeletePaths);
      }
      const nextLocalState = mergedLocalState;
      const nextRetryCount = patch.retryCount ?? current.retryCount;
      const nextRetryAt =
        patch.nextRetryAt === undefined ? (current.nextRetryAt ?? null) : patch.nextRetryAt;
      const nextLastFlow = patch.lastFlow ?? current.lastFlow;
      // An explicit null clears the reason so a reasonless decision does not
      // leave the PREVIOUS decision's remediation on the banner; an absent
      // field (partial patches) keeps the current value.
      const nextLastReason =
        patch.lastReason === undefined ? current.lastReason : (patch.lastReason ?? undefined);

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
