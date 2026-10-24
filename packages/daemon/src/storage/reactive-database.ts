import { EventEmitter } from 'node:events';
import { Database } from './index.ts';

export interface TableChangeScope {
  sessionId?: string;
  sessionType?: string;
  roomId?: string;
  spaceId?: string;
  taskId?: string;
  messageSubtype?: string | null;
}

export interface TableChangeEvent {
  tables: string[];
  versions: Record<string, number>;
  scope?: TableChangeScope;
}

export interface TableVersionEvent {
  table: string;
  version: number;
  scope?: TableChangeScope;
}

export interface ReactiveDatabase {
  db: Database;
  on(event: 'change', listener: (data: TableChangeEvent) => void): void;
  on(event: `change:${string}`, listener: (data: TableVersionEvent) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  getTableVersion(table: string): number;
  beginTransaction(): void;
  commitTransaction(): void;
  abortTransaction(): void;
  notifyChange(table: string, scope?: TableChangeScope): void;
  willEmitTableChange(table: string): boolean;
  resolveTaskIdForSession(sessionId: string): string | null;
  forgetSessionTask(sessionId: string): void;
}

interface MethodMapping {
  table: string;
  extractScope?: (args: unknown[], db: Database) => TableChangeScope | undefined;
}

const TASK_SESSION_TYPES = ['worker'];
const taskIdCacheByDb = new WeakMap<Database, Map<string, string | null>>();

function taskIdCacheFor(db: Database): Map<string, string | null> {
  let cache = taskIdCacheByDb.get(db);
  if (!cache) {
    cache = new Map();
    taskIdCacheByDb.set(db, cache);
  }
  return cache;
}

function resolveTaskIdForSession(db: Database, sessionId: string): string | null {
  const cache = taskIdCacheFor(db);
  const cached = cache.get(sessionId);
  if (cached !== undefined) return cached;
  try {
    const row = db
      .getDatabase()
      .prepare(`SELECT task_id, type FROM sessions WHERE id = ?`)
      .get(sessionId) as { task_id: string | null; type: string | null } | undefined;
    const taskId =
      row?.type && TASK_SESSION_TYPES.includes(row.type) ? (row.task_id ?? null) : null;
    cache.set(sessionId, taskId);
    return taskId;
  } catch {
    return null;
  }
}

export function sdkMessageScope(db: Database, sessionId: unknown): TableChangeScope {
  if (typeof sessionId !== 'string') return {};
  return { sessionId, taskId: resolveTaskIdForSession(db, sessionId) ?? undefined };
}

export function sdkMessageSubtype(message: unknown): string | null | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const subtype = (message as { subtype?: unknown }).subtype;
  if (subtype === undefined || subtype === null) return null;
  return typeof subtype === 'string' ? subtype : undefined;
}

export function messageIdsScope(db: Database, messageIds: unknown): TableChangeScope {
  if (!Array.isArray(messageIds) || messageIds.length === 0) return {};
  try {
    const ids = messageIds.filter((id): id is string => typeof id === 'string');
    if (ids.length === 0) return {};
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .getDatabase()
      .prepare(
        `SELECT DISTINCT session_id, task_id FROM sdk_messages WHERE id IN (${placeholders})`
      )
      .all(...ids) as Array<{ session_id: string | null; task_id: string | null }>;
    return (
      mergeScopes(
        rows.map((row) => ({
          sessionId: row.session_id ?? undefined,
          taskId: row.task_id ?? undefined,
        }))
      ) ?? {}
    );
  } catch {
    return {};
  }
}

export function messageIdScope(db: Database, messageId: unknown): TableChangeScope {
  if (typeof messageId !== 'string') return {};
  try {
    const row = db
      .getDatabase()
      .prepare(`SELECT session_id, task_id FROM sdk_messages WHERE id = ?`)
      .get(messageId) as { session_id: string | null; task_id: string | null } | undefined;
    return { sessionId: row?.session_id ?? undefined, taskId: row?.task_id ?? undefined };
  } catch {
    return {};
  }
}

export function mergeScopes(scopes: TableChangeScope[]): TableChangeScope | undefined {
  if (scopes.length === 0) return undefined;
  const merged: TableChangeScope = {};
  const keys: Array<keyof TableChangeScope> = [
    'sessionId',
    'sessionType',
    'roomId',
    'spaceId',
    'taskId',
  ];
  for (const scope of scopes) {
    for (const key of keys) {
      const value = scope[key];
      if (!value) continue;
      if (merged[key] && merged[key] !== value) return undefined;
      merged[key] = value;
    }
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

const METHOD_TABLE_MAP: Record<string, MethodMapping> = {
  saveSDKMessage: {
    table: 'sdk_messages',
    extractScope: (args, db) => ({
      ...sdkMessageScope(db, args[0]),
      messageSubtype: sdkMessageSubtype(args[1]),
    }),
  },
  saveUserMessage: {
    table: 'sdk_messages',
    extractScope: (args, db) => sdkMessageScope(db, args[0]),
  },
  updateMessageStatus: {
    table: 'sdk_messages',
    extractScope: (args, db) => messageIdsScope(db, args[0]),
  },
  updateMessageTimestamp: {
    table: 'sdk_messages',
    extractScope: (args, db) => messageIdScope(db, args[0]),
  },
  deletePendingUserMessage: {
    table: 'sdk_messages',
    extractScope: (args) => ({ sessionId: args[0] as string }),
  },
  deleteMessagesAfter: {
    table: 'sdk_messages',
    extractScope: (args) => ({ sessionId: args[0] as string }),
  },
  deleteMessagesAtAndAfter: {
    table: 'sdk_messages',
    extractScope: (args) => ({ sessionId: args[0] as string }),
  },
  saveGlobalSettings: { table: 'global_settings' },
  updateGlobalSettings: { table: 'global_settings' },
  createInboxItem: { table: 'inbox_items' },
  updateInboxItemStatus: { table: 'inbox_items' },
  dismissInboxItem: { table: 'inbox_items' },
  blockInboxItem: { table: 'inbox_items' },
  deleteInboxItem: { table: 'inbox_items' },
  deleteInboxItemsForRepository: { table: 'inbox_items' },
};

export function createReactiveDatabase(db: Database): ReactiveDatabase {
  const emitter = new EventEmitter();
  const tableVersions: Record<string, number> = {};
  let transactionDepth = 0;
  let batch: { aborted: boolean } | null = null;
  const pendingTables = new Set<string>();
  const pendingTableScopes = new Map<string, TableChangeScope | null>();
  const proxiedTableWrites: string[] = [];

  function getVersion(table: string): number {
    return tableVersions[table] ?? 0;
  }

  function addPendingScope(table: string, scope?: TableChangeScope): void {
    if (!scope?.sessionId && !scope?.taskId) {
      pendingTableScopes.set(table, null);
      return;
    }
    const current = pendingTableScopes.get(table);
    if (current === null) return;
    if (!current) {
      pendingTableScopes.set(table, scope);
      return;
    }
    pendingTableScopes.set(table, mergeScopes([current, scope]) ?? null);
  }

  function incrementAndEmit(
    table: string,
    scope?: TableChangeScope,
    batched = transactionDepth > 0
  ): void {
    tableVersions[table] = getVersion(table) + 1;
    const version = tableVersions[table];

    if (batched) {
      pendingTables.add(table);
      addPendingScope(table, scope);
      return;
    }

    const versionEvent: TableVersionEvent = { table, version, scope };
    emitter.emit(`change:${table}`, versionEvent);

    const changeEvent: TableChangeEvent = {
      tables: [table],
      versions: { [table]: version },
      scope,
    };
    emitter.emit('change', changeEvent);
  }

  function flushPendingTables(): void {
    if (pendingTables.size === 0) return;

    const tables = Array.from(pendingTables);
    pendingTables.clear();

    const versions: Record<string, number> = {};
    const tableScopes = new Map(pendingTableScopes);
    pendingTableScopes.clear();
    const hasUnscopedTable = tables.some((table) => tableScopes.get(table) === null);
    const scopes = tables.map((table) => tableScopes.get(table) ?? undefined);
    const eventScope = hasUnscopedTable
      ? undefined
      : mergeScopes(scopes.filter((scope): scope is TableChangeScope => !!scope));

    for (const table of tables) {
      const version = getVersion(table);
      versions[table] = version;
      const tableScope = tableScopes.get(table) ?? eventScope;
      const versionEvent: TableVersionEvent = { table, version, scope: tableScope };
      emitter.emit(`change:${table}`, versionEvent);
    }

    const changeEvent: TableChangeEvent = { tables, versions, scope: eventScope };
    emitter.emit('change', changeEvent);
  }

  const proxied = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'beginTransaction') return reactiveDb.beginTransaction;
      if (prop === 'commitTransaction') return reactiveDb.commitTransaction;
      if (prop === 'abortTransaction') return reactiveDb.abortTransaction;

      const value = Reflect.get(target, prop, receiver);

      if (typeof prop !== 'string' || typeof value !== 'function') {
        return value;
      }

      const mapping = METHOD_TABLE_MAP[prop];
      if (!mapping) {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }

      return function (this: Database, ...args: unknown[]) {
        proxiedTableWrites.push(mapping.table);
        try {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          const scope = mapping.extractScope?.(args, target);
          if (!(result instanceof Promise)) {
            incrementAndEmit(mapping.table, scope);
            return result;
          }
          const issuedIn = batch;
          return result.then((settled) => {
            if (issuedIn?.aborted) tableVersions[mapping.table] = getVersion(mapping.table) + 1;
            else incrementAndEmit(mapping.table, scope, issuedIn !== null && issuedIn === batch);
            return settled;
          });
        } finally {
          proxiedTableWrites.pop();
        }
      };
    },
  });

  const reactiveDb = {
    db: proxied,
    on(event: string, listener: (...args: unknown[]) => void): void {
      emitter.on(event, listener);
    },
    off(event: string, listener: (...args: unknown[]) => void): void {
      emitter.off(event, listener);
    },
    getTableVersion(table: string): number {
      return getVersion(table);
    },
    beginTransaction(): void {
      if (transactionDepth === 0) batch = { aborted: false };
      transactionDepth += 1;
    },
    commitTransaction(): void {
      if (transactionDepth <= 0) return;
      transactionDepth -= 1;
      if (transactionDepth === 0) {
        batch = null;
        flushPendingTables();
      }
    },
    abortTransaction(): void {
      if (transactionDepth <= 0) return;
      transactionDepth -= 1;
      if (transactionDepth === 0) {
        if (batch) batch.aborted = true;
        batch = null;
        pendingTables.clear();
        pendingTableScopes.clear();
        taskIdCacheFor(db).clear();
      }
    },
    notifyChange(table: string, scope?: TableChangeScope): void {
      incrementAndEmit(table, scope);
    },
    willEmitTableChange(table: string): boolean {
      return proxiedTableWrites[proxiedTableWrites.length - 1] === table;
    },
    resolveTaskIdForSession(sessionId: string): string | null {
      return resolveTaskIdForSession(db, sessionId);
    },
    forgetSessionTask(sessionId: string): void {
      taskIdCacheFor(db).delete(sessionId);
    },
  };
  return reactiveDb as ReactiveDatabase;
}
