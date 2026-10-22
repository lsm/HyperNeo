import { runLagPhase } from '../lib/event-loop-activity.ts';
import { Database as BunDatabase } from './sqlite-compat.ts';
import { Logger } from '../lib/logger.ts';
import { hashString32 } from '../lib/runtime-hash.ts';
import type { ReactiveDatabase, TableChangeScope } from './reactive-database.ts';

const log = new Logger('live-query');

export interface LiveQueryHandle<T> {
  get(): T[];
  ready?: Promise<void>;
  dispose(): void;
}

export interface LiveQueryEvaluation {
  rows: Record<string, unknown>[];
  metadata?: Record<string, unknown>;
  hashes?: { hash: number; rowHashes: [unknown, number][] | null };
}

export interface LiveQuerySubscribeOptions {
  evaluateAsync?: () => Promise<LiveQueryEvaluation>;
  onError?: (error: Error) => void;
  expandRows?: (
    rows: Record<string, unknown>[],
    params: ReadonlyArray<unknown>
  ) => Record<string, unknown>[];
  debounceMs?: number;
  getMetadata?: (
    rows: Record<string, unknown>[],
    params: ReadonlyArray<unknown>
  ) => Record<string, unknown> | undefined;
  scopeFilter?: (scope: TableChangeScope) => boolean;
  metadataScopeFilter?: (scope: TableChangeScope) => boolean;
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
  initialized?: boolean;
  resolveReady?: () => void;
  rejectReady?: (error: Error) => void;
  onError?: (error: Error) => void;
}

interface QueryEntry<T extends Record<string, unknown>> {
  expandRows: LiveQuerySubscribeOptions['expandRows'];
  evaluateAsync?: LiveQuerySubscribeOptions['evaluateAsync'];
  generation: number;
  inFlight: boolean;
  hasSnapshot: boolean;
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
  metadataScopeFilter: ((scope: TableChangeScope) => boolean) | undefined;
  metadataDirty: boolean;
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
    if (this.disposed) throw new Error('Live query engine disposed');
    const cacheKey = (options.evaluateAsync ? 'async\0' : '') + sql + '\0' + JSON.stringify(params);
    const debounceMs = Math.max(0, Math.floor(options.debounceMs ?? 0));

    let entry = this.queries.get(cacheKey) as QueryEntry<T> | undefined;

    if (!entry) {
      const rows = options.evaluateAsync ? [] : this.runQuery<T>(sql, params, options.expandRows);
      const hashSnapshot = runLagPhase('live_query:hash_rows', () =>
        hashRows(rows, options.rowFingerprint)
      );
      const tables = extractTables(sql);
      const cachedMetadata = options.evaluateAsync
        ? undefined
        : options.getMetadata?.(rows, params);

      entry = {
        evaluateAsync: options.evaluateAsync,
        generation: 0,
        inFlight: false,
        hasSnapshot: !options.evaluateAsync,
        expandRows: options.expandRows,
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
        metadataScopeFilter: options.metadataScopeFilter,
        metadataDirty: false,
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

    const subscriber: Subscriber<T> = { onChange, disposed: false, onError: options.onError };
    const ready = entry.evaluateAsync
      ? new Promise<void>((resolve, reject) => {
          subscriber.resolveReady = resolve;
          subscriber.rejectReady = reject;
        })
      : undefined;
    void ready?.catch(() => {});
    entry.subscribers.add(subscriber);
    if (entry.hasSnapshot) {
      subscriber.initialized = true;
      onChange({
        type: 'snapshot',
        rows: entry.cachedRows.slice(),
        version: this.computeVersion(entry.tables),
        metadata: entry.cachedMetadata,
      });
      subscriber.resolveReady?.();
    } else this.scheduleEvaluation(cacheKey, entry as QueryEntry<Record<string, unknown>>);

    return {
      ready,
      get: () => entry.cachedRows.slice(),
      dispose: () => {
        subscriber.disposed = true;
        subscriber.rejectReady?.(new Error('Live query subscription disposed'));
        entry.subscribers.delete(subscriber);
        if (!entry.subscribers.size)
          this.dropQuery(cacheKey, entry as QueryEntry<Record<string, unknown>>);
      },
    };
  }

  private dropQuery(cacheKey: string, entry: QueryEntry<Record<string, unknown>>): void {
    if (this.queries.get(cacheKey) !== entry) return;
    if (entry.pendingTimer) clearTimeout(entry.pendingTimer);
    this.queries.delete(cacheKey);
    for (const table of entry.tables) {
      const keys = this.tableIndex.get(table);
      keys?.delete(cacheKey);
      if (!keys?.size) this.tableIndex.delete(table);
    }
  }

  private scheduleEvaluation(cacheKey: string, entry: QueryEntry<Record<string, unknown>>): void {
    if (entry.pendingEval || entry.inFlight) return;
    entry.pendingEval = true;
    if (entry.debounceMs > 0 && entry.hasSnapshot) {
      entry.pendingTimer = setTimeout(() => this.evaluateQuery(cacheKey, entry), entry.debounceMs);
    } else queueMicrotask(() => this.evaluateQuery(cacheKey, entry));
  }

  dispose(): void {
    this.disposed = true;
    this.reactiveDb.off('change', this.changeListener as (...args: unknown[]) => void);
    for (const entry of this.queries.values()) {
      for (const subscriber of entry.subscribers) {
        subscriber.disposed = true;
        subscriber.rejectReady?.(new Error('Live query engine disposed'));
      }
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
      if (!entry) continue;

      if (scope && entry.scopeFilter && !entry.scopeFilter(scope)) {
        skipped++;
        continue;
      }

      if (!scope || !entry.metadataScopeFilter || entry.metadataScopeFilter(scope)) {
        entry.metadataDirty = true;
      }
      entry.generation++;
      if (entry.pendingEval || entry.inFlight) continue;
      evaluated++;
      this.scheduleEvaluation(cacheKey, entry);
    }

    log.debug(
      `table=${table} scope=${scope ? 'present' : 'none'} evaluated=${evaluated} skipped=${skipped} total=${keys.size}`
    );
  }

  private evaluateQuery(cacheKey: string, expected: QueryEntry<Record<string, unknown>>): void {
    if (this.disposed) return;

    const entry = this.queries.get(cacheKey);
    if (!entry || entry !== expected) return;

    entry.pendingEval = false;
    entry.pendingTimer = null;
    if (entry.evaluateAsync) {
      void this.evaluateAsync(cacheKey, entry);
      return;
    }

    const newRows = this.runQuery(entry.sql, entry.params, entry.expandRows);
    const newHashSnapshot = runLagPhase('live_query:hash_rows', () =>
      hashRows(newRows, entry.rowFingerprint)
    );
    const metadataStale = entry.metadataDirty || !entry.metadataScopeFilter;
    entry.metadataDirty = false;
    const newMetadata = metadataStale
      ? entry.getMetadata?.(newRows, entry.params)
      : entry.cachedMetadata;
    const newMetadataHash = metadataStale ? hashMetadata(newMetadata) : entry.cachedMetadataHash;
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
      ...(metadataChanged ? { metadata: newMetadata } : {}),
    };

    for (const subscriber of entry.subscribers) {
      if (!subscriber.disposed) {
        subscriber.onChange(queryDiff);
      }
    }
  }

  private async evaluateAsync(
    cacheKey: string,
    entry: QueryEntry<Record<string, unknown>>
  ): Promise<void> {
    if (entry.inFlight) return;
    entry.inFlight = true;
    const generation = entry.generation,
      version = this.computeVersion(entry.tables);
    try {
      const result = await entry.evaluateAsync!();
      if (this.disposed || this.queries.get(cacheKey) !== entry) return;
      const hashes = result.hashes
        ? {
            hash: result.hashes.hash,
            rowHashes: result.hashes.rowHashes ? new Map(result.hashes.rowHashes) : null,
          }
        : hashRows(result.rows, entry.rowFingerprint);
      const metadataHash = hashMetadata(result.metadata);
      const metadataChanged = metadataHash !== entry.cachedMetadataHash;
      const changed = hashes.hash !== entry.cachedHash || metadataChanged;
      const diff = computeDiff(
        entry.cachedRows,
        result.rows,
        entry.cachedRowHashes,
        hashes.rowHashes
      );
      entry.cachedRows = result.rows;
      entry.cachedHash = hashes.hash;
      entry.cachedRowHashes = hashes.rowHashes;
      entry.cachedMetadata = result.metadata;
      entry.cachedMetadataHash = metadataHash;
      entry.metadataDirty = false;
      entry.hasSnapshot = true;
      for (const subscriber of entry.subscribers) {
        if (subscriber.disposed) continue;
        if (!subscriber.initialized) {
          subscriber.onChange({
            type: 'snapshot',
            rows: result.rows.slice(),
            version,
            metadata: result.metadata,
          });
          subscriber.initialized = true;
          subscriber.resolveReady?.();
        } else if (changed)
          subscriber.onChange({
            type: 'delta',
            rows: result.rows,
            ...diff,
            version,
            ...(metadataChanged ? { metadata: result.metadata } : {}),
          });
      }
    } catch (error) {
      if (this.disposed || this.queries.get(cacheKey) !== entry) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      this.dropQuery(cacheKey, entry);
      for (const subscriber of entry.subscribers) {
        subscriber.rejectReady?.(failure);
        if (subscriber.initialized && !subscriber.disposed) subscriber.onError?.(failure);
        subscriber.disposed = true;
      }
    } finally {
      entry.inFlight = false;
      if (!this.disposed && this.queries.get(cacheKey) === entry && generation !== entry.generation)
        this.scheduleEvaluation(cacheKey, entry);
    }
  }

  private runQuery<T extends Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<unknown>,
    expandRows?: LiveQuerySubscribeOptions['expandRows']
  ): T[] {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    const paramsArray = Array.from(params) as Parameters<typeof stmt.all>;
    const rows = stmt.all(...paramsArray) as T[];
    return (expandRows ? expandRows(rows, params) : rows) as T[];
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
