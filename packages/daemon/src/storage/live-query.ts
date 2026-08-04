/**
 * LiveQueryEngine
 *
 * Registers SQL queries with parameters and callbacks. When a table change event
 * fires from ReactiveDatabase, it re-evaluates all queries that depend on that
 * table, computes diffs, and invokes callbacks only when results actually changed.
 */

import { Database as BunDatabase } from './sqlite-compat';
import { Logger } from '../lib/logger';
import { hashString32 } from '../lib/runtime-hash';
import type { ReactiveDatabase, TableChangeScope } from './reactive-database';

const log = new Logger('live-query');

// ============================================================================
// Public API types
// ============================================================================

export interface LiveQueryHandle<T> {
  /** Get current cached result */
  get(): T[];
  /** Stop receiving updates */
  dispose(): void;
}

export interface LiveQuerySubscribeOptions {
  /**
   * Optional debounce for reevaluating this query after a table change.
   *
   * Default behavior remains microtask-based so normal UI surfaces stay
   * immediate. Expensive high-frequency feeds can opt in to a short debounce
   * to coalesce bursts of writes into one latest-state delta.
   */
  debounceMs?: number;
  /**
   * Optional metadata builder for the whole result set. It is evaluated once
   * per cached query evaluation, not once per subscriber.
   */
  getMetadata?: (
    rows: Record<string, unknown>[],
    params: ReadonlyArray<unknown>
  ) => Record<string, unknown> | undefined;
  /**
   * Optional scope filter. When a table-change event carries scope metadata,
   * this function decides whether the change is relevant to this particular
   * query subscription. Return `false` to skip re-evaluation entirely.
   *
   * When the scope is absent (e.g. transaction flushes, methods without scope
   * extraction) the filter is NOT called and the query is re-evaluated as
   * usual — this preserves the existing fallback-to-full-reevaluation
   * behaviour.
   *
   * Example: a `messages.bySession` subscription with `params[0] = "sess-A"`
   * would provide `(scope) => scope.sessionId === "sess-A"` so that writes
   * for session B skip re-evaluation of session A's feed.
   */
  scopeFilter?: (scope: TableChangeScope) => boolean;
}

export interface QueryDiff<T = Record<string, unknown>> {
  type: 'snapshot' | 'delta';
  rows: T[];
  added?: T[];
  removed?: T[];
  updated?: T[];
  version: number;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Internal types
// ============================================================================

interface Subscriber<T extends Record<string, unknown>> {
  onChange: (diff: QueryDiff<T>) => void;
  disposed: boolean;
}

interface QueryEntry<T extends Record<string, unknown>> {
  sql: string;
  params: ReadonlyArray<unknown>;
  tables: string[];
  cachedRows: T[];
  cachedHash: number;
  cachedRowHashes: Map<unknown, number> | null;
  cachedMetadata: Record<string, unknown> | undefined;
  cachedMetadataHash: number;
  getMetadata:
    | ((
        rows: Record<string, unknown>[],
        params: ReadonlyArray<unknown>
      ) => Record<string, unknown> | undefined)
    | undefined;
  subscribers: Set<Subscriber<T>>;
  /** True when a re-evaluation is already queued */
  pendingEval: boolean;
  /** Timer handle when the pending evaluation uses debounceMs instead of a microtask. */
  pendingTimer: ReturnType<typeof setTimeout> | null;
  /** Delay used for table-change reevaluations. */
  debounceMs: number;
  /** Scope filter — when set, skips re-evaluation for unrelated scopes. */
  scopeFilter: ((scope: TableChangeScope) => boolean) | undefined;
}

interface RowHashSnapshot {
  hash: number;
  rowHashes: Map<unknown, number> | null;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract table names referenced in FROM and JOIN clauses.
 *
 * Handles:
 * - Simple `FROM table` and all JOIN variants: LEFT JOIN, RIGHT JOIN,
 *   INNER JOIN, CROSS JOIN, FULL JOIN, LEFT OUTER JOIN, RIGHT OUTER JOIN
 * - Comma-separated tables in the FROM clause: `FROM a, b`
 * - Table aliases — `FROM items AS i` or `FROM items i` — returns base name
 * - Case-insensitive keywords; names are normalised to lowercase
 * - Subqueries: the pattern skips `FROM (` so the `(` is not treated as a
 *   table name; inner tables are still matched when the regex reaches them
 *
 * Known limitations (acceptable for the queries this engine handles):
 * - CTE aliases defined with `WITH alias AS (…)` may be captured as table
 *   names when they appear after a FROM/JOIN keyword.
 * - Quoted identifiers (`"my table"`, `` `col` ``) are not supported.
 *
 * @internal Exported for unit testing only.
 */
export function extractTables(sql: string): string[] {
  const tables = new Set<string>();

  // Match all JOIN variants followed by a bare identifier (not a `(`).
  // This covers: JOIN, INNER JOIN, LEFT JOIN, RIGHT JOIN, CROSS JOIN,
  // FULL JOIN, LEFT OUTER JOIN, RIGHT OUTER JOIN, etc.
  const joinPattern =
    /\b(?:(?:LEFT|RIGHT|INNER|CROSS|FULL)(?:\s+OUTER)?\s+)?JOIN\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = joinPattern.exec(sql)) !== null) {
    tables.add(match[1].toLowerCase());
  }

  // Match FROM clauses and walk the comma-separated table list that follows.
  // The pattern captures the raw list; we then split on commas and pick the
  // first identifier from each item (ignoring AS alias and positional alias).
  // We use a negative lookahead `(?!\s*\()` to skip `FROM (subquery)` openers.
  const fromPattern =
    /\bFROM\s+(?!\s*\()([a-zA-Z_][a-zA-Z0-9_\s,]*?)(?=\s+(?:WHERE|JOIN|ON|GROUP|ORDER|HAVING|LIMIT|UNION)\b|\s*(?:$|\)))/gi;
  while ((match = fromPattern.exec(sql)) !== null) {
    for (const part of match[1].split(',')) {
      const name = part.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
      if (name) {
        tables.add(name[1].toLowerCase());
      }
    }
  }

  return Array.from(tables);
}

function hashString(value: string): number {
  return hashString32(value);
}

/**
 * Build a compact hash for a result set.
 *
 * For the common `id`-keyed path, cache one hash per row so later diffs only
 * stringify newly fetched rows, not both the previous and next result sets.
 */
function hashRows(rows: Record<string, unknown>[]): RowHashSnapshot {
  const hasId = rows.length > 0 && 'id' in rows[0];
  if (!hasId) {
    return { hash: hashString(JSON.stringify(rows)), rowHashes: null };
  }

  const rowHashes = new Map<unknown, number>();
  const digestParts: string[] = [String(rows.length)];
  for (const row of rows) {
    const id = row['id'];
    const rowHash = hashString(JSON.stringify(row));
    rowHashes.set(id, rowHash);
    digestParts.push(`${String(id).length}:${String(id)}:${rowHash}`);
  }

  return { hash: hashString(digestParts.join('|')), rowHashes };
}

function hashMetadata(metadata: Record<string, unknown> | undefined): number {
  return metadata === undefined ? 0 : hashString(JSON.stringify(metadata));
}

/**
 * Compute a row-level diff between old and new result sets.
 * Uses `id` field when available; falls back to positional comparison.
 *
 * @internal Exported for testing only.
 */
export function computeDiff<T extends Record<string, unknown>>(
  oldRows: T[],
  newRows: T[],
  oldRowHashes?: Map<unknown, number> | null,
  newRowHashes?: Map<unknown, number> | null
): { added: T[]; removed: T[]; updated: T[] } {
  const hasId =
    (newRows.length > 0 && 'id' in newRows[0]) || (oldRows.length > 0 && 'id' in oldRows[0]);

  if (!hasId) {
    // Positional diff: compare by full JSON
    const oldSet = new Set(oldRows.map((r) => JSON.stringify(r)));
    const newSet = new Set(newRows.map((r) => JSON.stringify(r)));
    const added: T[] = newRows.filter((r) => !oldSet.has(JSON.stringify(r)));
    const removed: T[] = oldRows.filter((r) => !newSet.has(JSON.stringify(r)));
    return { added, removed, updated: [] };
  }

  const oldById = new Map<unknown, T>();
  for (const row of oldRows) {
    oldById.set(row['id'], row);
  }
  const newById = new Map<unknown, T>();
  for (const row of newRows) {
    newById.set(row['id'], row);
  }

  const added: T[] = [];
  const removed: T[] = [];
  const updated: T[] = [];

  for (const [id, newRow] of newById) {
    const oldRow = oldById.get(id);
    if (oldRow === undefined) {
      added.push(newRow);
    } else if (
      oldRowHashes && newRowHashes
        ? oldRowHashes.get(id) !== newRowHashes.get(id)
        : JSON.stringify(oldRow) !== JSON.stringify(newRow)
    ) {
      updated.push(newRow);
    }
  }
  for (const [id, oldRow] of oldById) {
    if (!newById.has(id)) {
      removed.push(oldRow);
    }
  }

  return { added, removed, updated };
}

// ============================================================================
// LiveQueryEngine
// ============================================================================

export class LiveQueryEngine {
  /** Map from cache key (`sql + JSON.stringify(params)`) to QueryEntry */
  private queries = new Map<string, QueryEntry<Record<string, unknown>>>();
  /** Map from table name to set of cache keys that depend on it */
  private tableIndex = new Map<string, Set<string>>();
  /**
   * Prepared statements keyed by SQL text. Public subscriptions resolve to
   * constant named-query SQL, so this stays bounded by the registry size.
   */
  private statements = new Map<string, ReturnType<BunDatabase['prepare']>>();
  private changeListener: (data: {
    tables: string[];
    versions: Record<string, number>;
    scope?: TableChangeScope;
  }) => void;
  private disposed = false;

  constructor(
    private db: BunDatabase,
    private reactiveDb: ReactiveDatabase
  ) {
    this.changeListener = (data) => {
      for (const table of data.tables) {
        this.onTableChange(table, data.scope);
      }
    };
    this.reactiveDb.on('change', this.changeListener);
  }

  /**
   * Register a live query. Executes immediately and delivers current results
   * to the callback as a 'snapshot'. Subsequent changes trigger 'delta' callbacks.
   */
  subscribe<T extends Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<unknown>,
    onChange: (diff: QueryDiff<T>) => void,
    options: LiveQuerySubscribeOptions = {}
  ): LiveQueryHandle<T> {
    const cacheKey = sql + '\0' + JSON.stringify(params);
    const debounceMs = Math.max(0, Math.floor(options.debounceMs ?? 0));

    let entry = this.queries.get(cacheKey) as QueryEntry<T> | undefined;

    if (!entry) {
      const rows = this.runQuery<T>(sql, params);
      const hashSnapshot = hashRows(rows);
      const tables = extractTables(sql);
      const cachedMetadata = options.getMetadata?.(rows, params);

      entry = {
        sql,
        params,
        tables,
        cachedRows: rows,
        cachedHash: hashSnapshot.hash,
        cachedRowHashes: hashSnapshot.rowHashes,
        cachedMetadata,
        cachedMetadataHash: hashMetadata(cachedMetadata),
        getMetadata: options.getMetadata,
        subscribers: new Set(),
        pendingEval: false,
        pendingTimer: null,
        debounceMs,
        scopeFilter: options.scopeFilter,
      } as unknown as QueryEntry<T>;

      this.queries.set(cacheKey, entry as unknown as QueryEntry<Record<string, unknown>>);

      for (const table of tables) {
        let keys = this.tableIndex.get(table);
        if (!keys) {
          keys = new Set();
          this.tableIndex.set(table, keys);
        }
        keys.add(cacheKey);
      }
    } else {
      if (debounceMs > entry.debounceMs) {
        entry.debounceMs = debounceMs;
      }
      if (!entry.getMetadata && options.getMetadata) {
        entry.getMetadata = options.getMetadata;
        entry.cachedMetadata = options.getMetadata(entry.cachedRows, entry.params);
        entry.cachedMetadataHash = hashMetadata(entry.cachedMetadata);
      }
    }

    const subscriber: Subscriber<T> = { onChange, disposed: false };
    (entry as QueryEntry<T>).subscribers.add(subscriber);

    // Deliver initial snapshot
    const version = this.computeVersion((entry as QueryEntry<T>).tables);
    onChange({
      type: 'snapshot',
      rows: (entry as QueryEntry<T>).cachedRows.slice(),
      version,
      metadata: (entry as QueryEntry<T>).cachedMetadata,
    });

    return {
      get: () => (entry as QueryEntry<T>).cachedRows.slice(),
      dispose: () => {
        subscriber.disposed = true;
        (entry as QueryEntry<T>).subscribers.delete(subscriber);
        // Clean up entry if no subscribers remain
        if ((entry as QueryEntry<T>).subscribers.size === 0) {
          if ((entry as QueryEntry<T>).pendingTimer) {
            clearTimeout((entry as QueryEntry<T>).pendingTimer!);
          }
          this.queries.delete(cacheKey);
          for (const table of (entry as QueryEntry<T>).tables) {
            const keys = this.tableIndex.get(table);
            if (keys) {
              keys.delete(cacheKey);
              if (keys.size === 0) {
                this.tableIndex.delete(table);
              }
            }
          }
        }
      },
    };
  }

  /** Dispose all subscriptions and stop listening to ReactiveDatabase. */
  dispose(): void {
    this.disposed = true;
    this.reactiveDb.off('change', this.changeListener as (...args: unknown[]) => void);
    for (const entry of this.queries.values()) {
      if (entry.pendingTimer) {
        clearTimeout(entry.pendingTimer);
      }
    }
    this.queries.clear();
    this.tableIndex.clear();
    this.statements.clear();
  }

  // ============================================================================
  // Private
  // ============================================================================

  private onTableChange(table: string, scope?: TableChangeScope): void {
    if (this.disposed) return;

    const keys = this.tableIndex.get(table.toLowerCase());
    if (!keys || keys.size === 0) return;

    let evaluated = 0;
    let skipped = 0;

    for (const cacheKey of keys) {
      const entry = this.queries.get(cacheKey);
      if (!entry || entry.pendingEval) continue;

      // Scope filtering: when scope metadata is available and the entry
      // has a filter, skip re-evaluation if the change is unrelated.
      if (scope && entry.scopeFilter && !entry.scopeFilter(scope)) {
        skipped++;
        continue;
      }

      evaluated++;
      entry.pendingEval = true;
      if (entry.debounceMs > 0) {
        entry.pendingTimer = setTimeout(() => this.evaluateQuery(cacheKey), entry.debounceMs);
      } else {
        queueMicrotask(() => this.evaluateQuery(cacheKey));
      }
    }

    log.debug(
      `table=${table} scope=${scope ? 'present' : 'none'} evaluated=${evaluated} skipped=${skipped} total=${keys.size}`
    );
  }

  private evaluateQuery(cacheKey: string): void {
    if (this.disposed) return;

    const entry = this.queries.get(cacheKey);
    if (!entry) return;

    entry.pendingEval = false;
    entry.pendingTimer = null;

    const newRows = this.runQuery(entry.sql, entry.params);
    const newHashSnapshot = hashRows(newRows);
    const newMetadata = entry.getMetadata?.(newRows, entry.params);
    const newMetadataHash = hashMetadata(newMetadata);
    const rowsChanged = newHashSnapshot.hash !== entry.cachedHash;
    const metadataChanged = newMetadataHash !== entry.cachedMetadataHash;

    if (!rowsChanged && !metadataChanged) return;

    const oldRows = entry.cachedRows;
    const diff = rowsChanged
      ? computeDiff(oldRows, newRows, entry.cachedRowHashes, newHashSnapshot.rowHashes)
      : { added: [], removed: [], updated: [] };
    const version = this.computeVersion(entry.tables);

    entry.cachedRows = newRows;
    entry.cachedHash = newHashSnapshot.hash;
    entry.cachedRowHashes = newHashSnapshot.rowHashes;
    entry.cachedMetadata = newMetadata;
    entry.cachedMetadataHash = newMetadataHash;

    const queryDiff: QueryDiff<Record<string, unknown>> = {
      type: 'delta',
      rows: newRows,
      added: diff.added,
      removed: diff.removed,
      updated: diff.updated,
      version,
      metadata: newMetadata,
    };

    for (const subscriber of entry.subscribers) {
      if (!subscriber.disposed) {
        subscriber.onChange(queryDiff);
      }
    }
  }

  private runQuery<T extends Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<unknown>
  ): T[] {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    const paramsArray = Array.from(params) as Parameters<typeof stmt.all>;
    return stmt.all(...paramsArray) as T[];
  }

  private computeVersion(tables: string[]): number {
    let max = 0;
    for (const table of tables) {
      const v = this.reactiveDb.getTableVersion(table);
      if (v > max) max = v;
    }
    return max;
  }
}
