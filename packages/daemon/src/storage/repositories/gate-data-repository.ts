/**
 * Gate Data Repository
 *
 * Persistence layer for gate runtime data, keyed by `(run_id, gate_id)`.
 * Gate data is a JSON key-value store that gate conditions evaluate against.
 * Agents write to gate data via MCP tools; the runtime reads it to decide
 * whether a gated channel is open.
 */

import type { Database as BunDatabase } from '../sqlite-compat';
import { Logger } from '../../lib/logger';

const log = new Logger('gate-data-repository');

/** A single gate data record as returned by the repository. */
export interface GateDataRecord {
  runId: string;
  gateId: string;
  data: Record<string, unknown>;
  updatedAt: number;
}

export class GateDataRepository {
  constructor(private db: BunDatabase) {}

  /**
   * Get gate data for a specific `(run_id, gate_id)` pair.
   * Returns null when no data has been written for this gate in this run,
   * OR when the stored JSON is corrupted (so the caller can fall back to the
   * gate's default data — e.g. `{ approved: false, waiting: true }` for
   * human-approval gates — rather than operating on an empty object).
   */
  get(runId: string, gateId: string): GateDataRecord | null {
    const row = this.db
      .prepare('SELECT * FROM gate_data WHERE run_id = ? AND gate_id = ?')
      .get(runId, gateId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToRecord(row, /* returnNullOnCorruption */ true);
  }

  /**
   * Get all gate data records for a workflow run.
   * Corrupted records are included with `data: {}` so callers can still
   * inspect all gate IDs; use `get()` for evaluation (which returns null on
   * corruption so the caller falls back to the gate's default data).
   */
  listByRun(runId: string): GateDataRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM gate_data WHERE run_id = ? ORDER BY gate_id')
      .all(runId) as Record<string, unknown>[];
    return rows
      .map((r) => this.rowToRecord(r, false))
      .filter((r): r is GateDataRecord => r !== null);
  }

  /**
   * Upsert gate data for a `(run_id, gate_id)` pair.
   * Replaces the entire data object — callers must merge before calling.
   *
   * When the new data is structurally identical to the existing data, `updated_at`
   * is preserved so timeout anchors (e.g. codex_review_bot) do not advance on
   * retry writes.
   */
  set(runId: string, gateId: string, data: Record<string, unknown>): GateDataRecord {
    const existing = this.get(runId, gateId);
    if (existing && JSON.stringify(existing.data) === JSON.stringify(data)) {
      return existing;
    }

    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO gate_data (run_id, gate_id, data, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(run_id, gate_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      )
      .run(runId, gateId, JSON.stringify(data), now);

    return { runId, gateId, data, updatedAt: now };
  }

  /**
   * Merge partial data into an existing gate data record.
   * Creates the record with the provided partial data if it does not exist.
   *
   * **Shallow merge only**: top-level keys in `partial` overwrite existing keys.
   * Nested objects are replaced wholesale, not merged recursively.
   * Example: merging `{ nested: { b: 2 } }` into `{ nested: { a: 1 } }`
   * yields `{ nested: { b: 2 } }` — `a` is lost.
   *
   * Atomic within `bun:sqlite`: read, merge, and write run inside a single
   * SQLite transaction so a concurrent `reset()` (e.g. from
   * `incrementAndResetCyclicChannel`) cannot interleave between the read and
   * the write and resurrect cleared keys. JS is single-threaded so this is
   * already safe today, but the transaction is cheap and prevents future
   * regressions if `await` boundaries are added between read and write.
   */
  merge(runId: string, gateId: string, partial: Record<string, unknown>): GateDataRecord {
    return this.db.transaction(() => {
      const existing = this.get(runId, gateId);
      const merged = existing ? { ...existing.data, ...partial } : { ...partial };
      return this.set(runId, gateId, merged);
    })();
  }

  /**
   * Merge partial data into an existing gate data record without advancing
   * `updated_at`. Use this when persisting script-derived metadata (e.g.
   * `head_sha`) that must not restamp the gate-data timestamp used by
   * timeout/freshness anchors.
   */
  mergePreserveTimestamp(
    runId: string,
    gateId: string,
    partial: Record<string, unknown>
  ): GateDataRecord {
    return this.db.transaction(() => {
      const existing = this.get(runId, gateId);
      const merged = existing ? { ...existing.data, ...partial } : { ...partial };
      if (existing && JSON.stringify(existing.data) === JSON.stringify(merged)) {
        return existing;
      }
      const updatedAt = existing?.updatedAt ?? Date.now();
      this.db
        .prepare(
          `INSERT INTO gate_data (run_id, gate_id, data, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(run_id, gate_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
        )
        .run(runId, gateId, JSON.stringify(merged), updatedAt);
      return { runId, gateId, data: merged, updatedAt };
    })();
  }

  /**
   * Merge partial data into an existing gate data record, deep-merging
   * nominated map-typed fields instead of replacing them wholesale.
   *
   * Top-level keys in `partial` shallow-overwrite existing keys, *except*
   * for keys listed in `mapFields` — for those, if both the existing value
   * and the new value are plain (non-array) objects, their entries are
   * shallow-merged so per-writer entries accumulate instead of clobbering
   * each other.
   *
   * The whole read-merge-write sequence runs inside a SQLite transaction
   * so a concurrent `reset()` cannot interleave between the read and the
   * write — without this, a cyclic reset (e.g. on revision feedback) could
   * be silently undone by a stale snapshot from a peer reviewer's
   * gate-write that started before the reset.
   */
  mergeWithMapFields(
    runId: string,
    gateId: string,
    partial: Record<string, unknown>,
    mapFields: ReadonlySet<string>
  ): GateDataRecord {
    return this.db.transaction(() => {
      const existing = this.get(runId, gateId);
      const existingData = existing?.data ?? {};
      const next: Record<string, unknown> = { ...existingData };
      for (const [key, value] of Object.entries(partial)) {
        if (mapFields.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
          const existingMap = existingData[key];
          if (existingMap && typeof existingMap === 'object' && !Array.isArray(existingMap)) {
            next[key] = {
              ...(existingMap as Record<string, unknown>),
              ...(value as Record<string, unknown>),
            };
            continue;
          }
        }
        next[key] = value;
      }
      return this.set(runId, gateId, next);
    })();
  }

  /**
   * Delete gate data for a specific `(run_id, gate_id)` pair.
   * Returns true if a record was deleted.
   */
  delete(runId: string, gateId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM gate_data WHERE run_id = ? AND gate_id = ?')
      .run(runId, gateId);
    return result.changes > 0;
  }

  /**
   * Delete all gate data for a workflow run.
   * Returns the number of records deleted.
   */
  deleteByRun(runId: string): number {
    const result = this.db.prepare('DELETE FROM gate_data WHERE run_id = ?').run(runId);
    return result.changes;
  }

  /**
   * Initialize gate data for all gates in a workflow run.
   * Populates each gate's default data. Skips gates that already have data.
   *
   * Callers pass pre-computed defaults (via `computeGateDefaults(gate.fields)`)
   * or a plain `{}` object. The repository is agnostic to how defaults are computed.
   */
  initializeForRun(
    runId: string,
    gates: Array<{ id: string; data: Record<string, unknown> }>
  ): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO gate_data (run_id, gate_id, data, updated_at) VALUES (?, ?, ?, ?)`
    );
    const now = Date.now();
    for (const gate of gates) {
      const data = { ...gate.data, cycle_start_at: now };
      stmt.run(runId, gate.id, JSON.stringify(data), now);
    }
  }

  /**
   * Reset a gate's data to its defaults.
   * Used when a cyclic workflow loops back through a gate with `resetOnCycle: true`.
   * Injects `cycle_start_at` so per-cycle freshness anchors (e.g. codex_review_bot)
   * can distinguish reactions from the current cycle vs. prior cycles.
   */
  reset(runId: string, gateId: string, defaultData: Record<string, unknown>): GateDataRecord {
    return this.set(runId, gateId, { ...defaultData, cycle_start_at: Date.now() });
  }

  /**
   * @param row                   Raw SQLite row.
   * @param returnNullOnCorruption When true, returns null if JSON is corrupted so
   *                              the caller can fall back to the gate's default data
   *                              (e.g. `{ approved: false, waiting: true }` for
   *                              human-approval gates).  When false, returns the record
   *                              with `data: {}` so the caller can still inspect the
   *                              gate ID even when the payload is unreadable.
   */
  private rowToRecord(
    row: Record<string, unknown>,
    returnNullOnCorruption: boolean
  ): GateDataRecord | null {
    const runId = row.run_id as string;
    const gateId = row.gate_id as string;
    const raw = row.data as string;
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      return { runId, gateId, data, updatedAt: row.updated_at as number };
    } catch (err) {
      log.error(
        `GateDataRepository: corrupted gate data for run=${runId} gate=${gateId} — ` +
          `JSON.parse failed (${err instanceof Error ? err.message : String(err)}). ` +
          (returnNullOnCorruption
            ? 'Returning null so caller falls back to gate default data.'
            : 'Returning {} for inspection.')
      );
      if (returnNullOnCorruption) {
        return null;
      }
      return { runId, gateId, data: {}, updatedAt: row.updated_at as number };
    }
  }
}
