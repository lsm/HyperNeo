import { EventEmitter } from 'node:events';
import { Database } from './index';

export interface TableChangeScope {
  sessionId?: string;
  sessionType?: string;
  roomId?: string;
  spaceId?: string;
  taskId?: string;
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
  resolveTaskIdForSession(sessionId: string): string | null;
}

interface MethodMapping {
  table: string;
  extractScope?: (args: unknown[], db: Database) => TableChangeScope;
}

const TASK_SESSION_TYPES = ['space_task_agent', 'worker'];
const SESSION_TABLE_WRITE_METHODS = new Set(['createSession', 'updateSession', 'deleteSession']);

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
      .prepare(
        `SELECT
					CASE
						WHEN session_context IS NULL THEN NULL
						WHEN NOT json_valid(session_context) THEN NULL
						ELSE json_extract(session_context, '$.taskId')
					END AS task_id,
					type
				 FROM sessions WHERE id = ?`
      )
      .get(sessionId) as { task_id: string | null; type: string | null } | undefined;
    const taskId =
      row?.type && TASK_SESSION_TYPES.includes(row.type) ? (row.task_id ?? null) : null;
    cache.set(sessionId, taskId);
    return taskId;
  } catch {
    return null;
  }
}

function invalidateTaskIdForSession(db: Database, sessionId: string | undefined): void {
  if (sessionId) taskIdCacheFor(db).delete(sessionId);
}

function sessionWriteInvalidatesTaskId(method: string, args: unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === 'string') {
    if (method === 'updateSession') {
      const updates = args[1];
      if (updates && typeof updates === 'object') {
        const record = updates as { context?: unknown; type?: unknown };
        if (!('context' in record) && record.type === undefined) return undefined;
      }
    }
    return first;
  }
  if (first && typeof first === 'object') {
    const id = (first as { id?: unknown }).id;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

function sessionScopeFromRow(row: {
  id: string;
  type: string | null;
  session_context: string | null;
}): TableChangeScope {
  let context: Record<string, unknown> | undefined;
  if (row.session_context) {
    try {
      context = JSON.parse(row.session_context) as Record<string, unknown>;
    } catch {
      context = undefined;
    }
  }
  return {
    sessionId: row.id,
    sessionType: row.type ?? undefined,
    roomId: typeof context?.roomId === 'string' ? context.roomId : undefined,
    spaceId: typeof context?.spaceId === 'string' ? context.spaceId : undefined,
    taskId: typeof context?.taskId === 'string' ? context.taskId : undefined,
  };
}

function sessionScope(db: Database, sessionId: unknown): TableChangeScope {
  if (typeof sessionId !== 'string') return {};
  try {
    const row = db
      .getDatabase()
      .prepare('SELECT id, type, session_context FROM sessions WHERE id = ?')
      .get(sessionId) as
      | { id: string; type: string | null; session_context: string | null }
      | undefined;
    return row ? sessionScopeFromRow(row) : { sessionId };
  } catch {
    return { sessionId };
  }
}

function createSessionScope(_db: Database, session: unknown): TableChangeScope {
  if (!session || typeof session !== 'object') return {};
  const value = session as {
    id?: unknown;
    type?: unknown;
    context?: { roomId?: unknown; spaceId?: unknown; taskId?: unknown };
  };
  if (typeof value.id !== 'string') return {};
  return {
    sessionId: value.id,
    sessionType: typeof value.type === 'string' ? value.type : undefined,
    roomId: typeof value.context?.roomId === 'string' ? value.context.roomId : undefined,
    spaceId: typeof value.context?.spaceId === 'string' ? value.context.spaceId : undefined,
    taskId: typeof value.context?.taskId === 'string' ? value.context.taskId : undefined,
  };
}

function sdkMessageScope(db: Database, sessionId: unknown): TableChangeScope {
  if (typeof sessionId !== 'string') return {};
  return { sessionId, taskId: resolveTaskIdForSession(db, sessionId) ?? undefined };
}

function messageIdsScope(db: Database, messageIds: unknown): TableChangeScope {
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

function messageIdScope(db: Database, messageId: unknown): TableChangeScope {
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

function mergeScopes(scopes: TableChangeScope[]): TableChangeScope | undefined {
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
  createSession: { table: 'sessions', extractScope: (args, db) => createSessionScope(db, args[0]) },
  updateSession: { table: 'sessions', extractScope: (args, db) => sessionScope(db, args[0]) },
  deleteSession: { table: 'sessions', extractScope: (args, db) => sessionScope(db, args[0]) },
  saveSDKMessage: {
    table: 'sdk_messages',
    extractScope: (args, db) => sdkMessageScope(db, args[0]),
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
  saveGlobalToolsConfig: { table: 'global_tools_config' },
  saveGlobalSettings: { table: 'global_settings' },
  updateGlobalSettings: { table: 'global_settings' },
  createGitHubMapping: { table: 'room_github_mappings' },
  updateGitHubMapping: { table: 'room_github_mappings' },
  deleteGitHubMapping: { table: 'room_github_mappings' },
  deleteGitHubMappingByRoomId: { table: 'room_github_mappings' },
  createInboxItem: { table: 'inbox_items' },
  updateInboxItemStatus: { table: 'inbox_items' },
  dismissInboxItem: { table: 'inbox_items' },
  routeInboxItem: { table: 'inbox_items' },
  blockInboxItem: { table: 'inbox_items' },
  deleteInboxItem: { table: 'inbox_items' },
  deleteInboxItemsForRepository: { table: 'inbox_items' },
};

export function createReactiveDatabase(db: Database): ReactiveDatabase {
  const emitter = new EventEmitter();
  const tableVersions: Record<string, number> = {};
  let transactionDepth = 0;
  const pendingTables = new Set<string>();
  const pendingTableScopes = new Map<string, TableChangeScope | null>();

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

  function incrementAndEmit(table: string, scope?: TableChangeScope): void {
    tableVersions[table] = getVersion(table) + 1;
    const version = tableVersions[table];

    if (transactionDepth > 0) {
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
        if (SESSION_TABLE_WRITE_METHODS.has(prop)) {
          invalidateTaskIdForSession(target, sessionWriteInvalidatesTaskId(prop, args));
        }
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        const scope = mapping.extractScope?.(args, target);
        incrementAndEmit(mapping.table, scope);
        return result;
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
      transactionDepth += 1;
    },
    commitTransaction(): void {
      if (transactionDepth <= 0) return;
      transactionDepth -= 1;
      if (transactionDepth === 0) {
        flushPendingTables();
      }
    },
    abortTransaction(): void {
      if (transactionDepth <= 0) return;
      transactionDepth -= 1;
      if (transactionDepth === 0) {
        pendingTables.clear();
        pendingTableScopes.clear();
        taskIdCacheFor(db).clear();
      }
    },
    notifyChange(table: string, scope?: TableChangeScope): void {
      incrementAndEmit(table, scope);
    },
    resolveTaskIdForSession(sessionId: string): string | null {
      return resolveTaskIdForSession(db, sessionId);
    },
  };
  return reactiveDb as ReactiveDatabase;
}
