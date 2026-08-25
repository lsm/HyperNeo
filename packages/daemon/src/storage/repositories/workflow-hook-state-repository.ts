import type { Database as BunDatabase } from '../sqlite-compat.ts';
import {
  generateUUID,
  type WorkflowHookResult,
  type WorkflowHookStateSnapshot,
} from '@hyperneo/shared';

interface HookStateRow {
  run_id: string;
  hook_id: string;
  version: number;
  local_state: string;
  last_result: string | null;
  retry_count: number;
  next_retry_at: number | null;
  vote_maps: string;
  created_at: number;
  updated_at: number;
}

export interface WorkflowHookStatePatch {
  expectedVersion: number;
  localState?: Record<string, unknown>;
  lastResult?: WorkflowHookResult;
  retryCount?: number;
  nextRetryAt?: number | null;
  voteMaps?: Record<string, Record<string, unknown>>;
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

function mergeVoteMaps(
  base: Record<string, Record<string, unknown>>,
  patch: Record<string, Record<string, unknown>>
): Record<string, Record<string, unknown>> {
  const next: Record<string, Record<string, unknown>> = { ...base };
  for (const [mapName, votes] of Object.entries(patch)) {
    next[mapName] = { ...next[mapName], ...votes };
  }
  return next;
}

function rowToSnapshot(row: HookStateRow): WorkflowHookStateSnapshot {
  return {
    runId: row.run_id,
    hookId: row.hook_id,
    version: row.version,
    localState: parseJson(row.local_state, {}),
    lastResult: parseJson<WorkflowHookResult | undefined>(row.last_result, undefined),
    retryCount: row.retry_count,
    nextRetryAt: row.next_retry_at ?? undefined,
    voteMaps: parseJson(row.vote_maps, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WorkflowHookStateRepository {
  constructor(private db: BunDatabase) {}

  get(runId: string, hookId: string): WorkflowHookStateSnapshot | null {
    const row = this.db
      .prepare(`SELECT * FROM workflow_hook_state WHERE run_id = ? AND hook_id = ?`)
      .get(runId, hookId) as HookStateRow | undefined;
    return row ? rowToSnapshot(row) : null;
  }

  ensure(
    runId: string,
    hookId: string,
    defaults: Record<string, unknown> = {}
  ): WorkflowHookStateSnapshot {
    const existing = this.get(runId, hookId);
    if (existing) return existing;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO workflow_hook_state
          (run_id, hook_id, version, local_state, last_result, retry_count, next_retry_at, vote_maps, created_at, updated_at)
         VALUES (?, ?, 0, ?, NULL, 0, NULL, '{}', ?, ?)`
      )
      .run(runId, hookId, JSON.stringify(defaults), now, now);
    return this.get(runId, hookId)!;
  }

  listByRun(runId: string): WorkflowHookStateSnapshot[] {
    const rows = this.db
      .prepare(`SELECT * FROM workflow_hook_state WHERE run_id = ?`)
      .all(runId) as HookStateRow[];
    return rows.map(rowToSnapshot);
  }

  update(
    runId: string,
    hookId: string,
    patch: WorkflowHookStatePatch
  ): WorkflowHookStateSnapshot | null {
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
      const nextVoteMaps = patch.voteMaps
        ? mergeVoteMaps(current.voteMaps, patch.voteMaps)
        : current.voteMaps;
      const nextRetryCount = patch.retryCount ?? current.retryCount;
      const nextRetryAt =
        patch.nextRetryAt === undefined ? (current.nextRetryAt ?? null) : patch.nextRetryAt;
      const nextLastResult = patch.lastResult ?? current.lastResult;

      const result = this.db
        .prepare(
          `UPDATE workflow_hook_state
           SET version = ?, local_state = ?, last_result = ?, retry_count = ?, next_retry_at = ?, vote_maps = ?, updated_at = ?
           WHERE run_id = ? AND hook_id = ? AND version = ?`
        )
        .run(
          nextVersion,
          JSON.stringify(nextLocalState),
          nextLastResult ? JSON.stringify(nextLastResult) : null,
          nextRetryCount,
          nextRetryAt,
          JSON.stringify(nextVoteMaps),
          now,
          runId,
          hookId,
          patch.expectedVersion
        );
      if (result.changes === 0) return null;
      if (patch.lastResult)
        this.appendResultArtifact(runId, hookId, nextVersion, patch.lastResult, now);
      return this.get(runId, hookId);
    });
    return tx();
  }

  private appendResultArtifact(
    runId: string,
    hookId: string,
    version: number,
    result: WorkflowHookResult,
    now: number
  ): void {
    this.db
      .prepare(
        `INSERT INTO workflow_hook_result_artifacts (id, run_id, hook_id, version, result, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(generateUUID(), runId, hookId, version, JSON.stringify(result), now);
  }
}
