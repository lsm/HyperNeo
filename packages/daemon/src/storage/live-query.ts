import { Database as BunDatabase } from './sqlite-compat.ts';
import { Logger } from '../lib/logger.ts';
import { hashString32 } from '../lib/runtime-hash.ts';
import type { ReactiveDatabase, TableChangeScope } from './reactive-database.ts';

const log = new Logger('live-query');

export interface LiveQueryHandle<T> {
  get(): T[];
  dispose(): void;
}

export interface LiveQuerySubscribeOptions {
  debounceMs?: number;
  getMetadata?: (
    rows: Record<string, unknown>[],
    params: ReadonlyArray<unknown>
  ) => Record<string, unknown> | undefined;
  scopeFilter?: (scope: TableChangeScope) => boolean;
  rowFingerprint?: (row: Record<string, unknown>) => unknown;
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
  pendingEval: boolean;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  debounceMs: number;
  scopeFilter: ((scope: TableChangeScope) => boolean) | undefined;
  rowFingerprint: ((row: Record<string, unknown>) => unknown) | undefined;
}

interface RowHashSnapshot {
  hash: number;
  rowHashes: Map<unknown, number> | null;
}

export function extractTables(sql: string): string[] {
  const tables = new Set<string>();

  const joinPattern =
    /\b(?:(?:LEFT|RIGHT|INNER|CROSS|FULL)(?:\s+OUTER)?\s+)?JOIN\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = joinPattern.exec(sql)) !== null) {
    tables.add(match[1].toLowerCase());
  }

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

export function hashRows(
  rows: Record<string, unknown>[],
  rowFingerprint?: (row: Record<string, unknown>) => unknown
): RowHashSnapshot {
  const hasId = rows.length > 0 && 'id' in rows[0];
  if (!hasId) {
    return { hash: hashString(JSON.stringify(rows)), rowHashes: null };
  }

  const rowHashes = new Map<unknown, number>();
  const digestParts: string[] = [String(rows.length)];
  for (const row of rows) {
    const id = row['id'];
    const rowHash = hashString(JSON.stringify(rowFingerprint ? rowFingerprint(row) : row));
    rowHashes.set(id, rowHash);
    digestParts.push(`${String(id).length}:${String(id)}:${rowHash}`);
  }

  return { hash: hashString(digestParts.join('|')), rowHashes };
}

function hashMetadata(metadata: Record<string, unknown> | undefined): number {
  return metadata === undefined ? 0 : hashString(JSON.stringify(metadata));
}

export function computeDiff<T extends Record<string, unknown>>(
  oldRows: T[],
  newRows: T[],
  oldRowHashes?: Map<unknown, number> | null,
  newRowHashes?: Map<unknown, number> | null
): { added: T[]; removed: T[]; updated: T[] } {
  const hasId =
    (newRows.length > 0 && 'id' in newRows[0]) || (oldRows.length > 0 && 'id' in oldRows[0]);

  if (!hasId) {
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

export class LiveQueryEngine {
  private queries = new Map<string, QueryEntry<Record<string, unknown>>>();
  private tableIndex = new Map<string, Set<string>>();
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
      const hashSnapshot = hashRows(rows, options.rowFingerprint);
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
        rowFingerprint: options.rowFingerprint,
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

  private onTableChange(table: string, scope?: TableChangeScope): void {
    if (this.disposed) return;

    const keys = this.tableIndex.get(table.toLowerCase());
    if (!keys || keys.size === 0) return;

    let evaluated = 0;
    let skipped = 0;

    for (const cacheKey of keys) {
      const entry = this.queries.get(cacheKey);
      if (!entry || entry.pendingEval) continue;

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
    const newHashSnapshot = hashRows(newRows, entry.rowFingerprint);
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
