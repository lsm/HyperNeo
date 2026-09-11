import { Database } from '../../storage/sqlite-compat.ts';
import { type DbScopeType, type ScopeTableConfig, getScopeConfig } from './scope-config.ts';
import { validateSql } from './sql-validator.ts';

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 1000;

export interface ScopedDbQuery {
  sql: string;
  params?: unknown[];
  limit?: number;
}

export type ScopedDbQueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
};

function findTopLevelKeyword(sql: string, keyword: string): number {
  const upper = sql.toUpperCase();
  const kwLen = keyword.length;
  let depth = 0;
  let inString = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (inString) {
      if (ch === "'" && i + 1 < sql.length && sql[i + 1] === "'") {
        i++;
        continue;
      }
      if (ch === "'") {
        inString = false;
      }
      continue;
    }

    if (ch === "'") {
      inString = true;
      continue;
    }
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      depth--;
      continue;
    }

    if (depth === 0 && upper.slice(i, i + kwLen) === keyword) {
      const beforeOk = i === 0 || /\s/.test(sql[i - 1]);
      const afterChar = i + kwLen < sql.length ? sql[i + kwLen] : ' ';
      const afterOk = i + kwLen >= sql.length || /\s/.test(afterChar) || afterChar === '(';
      if (beforeOk && afterOk) return i;
    }
  }

  return -1;
}
function stripLimit(sql: string): { sql: string; userLimit?: number } {
  const limitPos = findTopLevelKeyword(sql, 'LIMIT');
  if (limitPos === -1) return { sql };

  const afterLimit = sql.slice(limitPos + 5).trim();
  const match = afterLimit.match(/^(\d+)/);
  const userLimit = match ? Number.parseInt(match[1], 10) : undefined;

  return { sql: sql.slice(0, limitPos).trimEnd(), userLimit };
}
const MAX_MATERIALIZED_ROWS = 50000;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function buildTableScopeFilter(
  config: ScopeTableConfig,
  scopeValue: string
): { whereClause: string; params: unknown[] } {
  if (config.scopeColumn) {
    return { whereClause: `${quoteIdent(config.scopeColumn)} = ?`, params: [scopeValue] };
  }

  if (config.scopeLike) {
    const { column, patternPrefix, patternSuffix } = config.scopeLike;
    return {
      whereClause: `${quoteIdent(column)} LIKE ?`,
      params: [`${patternPrefix}${scopeValue}${patternSuffix}`],
    };
  }

  if (config.scopeJoin) {
    const join = config.scopeJoin;
    const inner = `${quoteIdent(join.localColumn)} IN (SELECT ${quoteIdent(join.joinPkColumn)} FROM ${quoteIdent(join.joinTable)} WHERE ${quoteIdent(join.scopeColumn)}`;
    if (join.likePrefix !== undefined) {
      return {
        whereClause: `${inner} LIKE ?)`,
        params: [`${join.likePrefix}${scopeValue}${join.likeSuffix ?? ''}`],
      };
    }
    return { whereClause: `${inner} = ?)`, params: [scopeValue] };
  }

  return { whereClause: '', params: [] };
}

interface ScratchColumn {
  name: string;
  type: string;
}

function readableColumns(db: Database, config: ScopeTableConfig): ScratchColumn[] {
  const info = db.query(`PRAGMA table_xinfo(${quoteIdent(config.tableName)})`).all() as Array<{
    name: string;
    type: string;
    hidden: number;
  }>;
  const blacklisted = new Set(config.blacklistedColumns);
  return info
    .filter((c) => c.hidden !== 1 && !blacklisted.has(c.name))
    .map((c) => ({ name: c.name, type: c.type }));
}

function enableBigInts(stmt: unknown): void {
  const s = stmt as {
    safeIntegers?: (value: boolean) => void;
    setReadBigInts?: (value: boolean) => void;
  };
  s.safeIntegers?.(true);
  s.setReadBigInts?.(true);
}

function copySourceIndexes(
  source: Database,
  scratch: Database,
  tableName: string,
  fallbackColumn: string
): void {
  const indexes = source
    .query(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`
    )
    .all(tableName) as Array<{ sql: string }>;
  for (const index of indexes) {
    try {
      scratch.exec(index.sql);
    } catch {
      const name = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)/i.exec(
        index.sql
      )?.[1];
      if (!name) continue;
      try {
        scratch.exec(
          `CREATE INDEX ${name} ON ${quoteIdent(tableName)} (${quoteIdent(fallbackColumn)})`
        );
      } catch {
        continue;
      }
    }
  }
}

function materializeScopedTable(
  source: Database,
  scratch: Database,
  config: ScopeTableConfig,
  scopeValue: string
): void {
  const columns = readableColumns(source, config);
  if (columns.length === 0) return;

  const filter = buildTableScopeFilter(config, scopeValue);
  const where = filter.whereClause ? ` WHERE ${filter.whereClause}` : '';
  const names = columns.map((c) => c.name);
  const projection = names.map(quoteIdent).join(', ');
  const table = quoteIdent(config.tableName);

  let withRowid = true;
  let rows: Record<string, unknown>[];
  const select = (cols: string) => {
    const stmt = source.query(
      `SELECT ${cols} FROM ${table}${where} LIMIT ${MAX_MATERIALIZED_ROWS + 1}`
    );
    enableBigInts(stmt);
    return stmt.all(...(filter.params as [])) as Record<string, unknown>[];
  };
  try {
    rows = select(`rowid AS _dbq_rowid, ${projection}`);
  } catch {
    withRowid = false;
    rows = select(projection);
  }

  if (rows.length > MAX_MATERIALIZED_ROWS) {
    throw new Error(
      `Table "${config.tableName}" holds more than ${MAX_MATERIALIZED_ROWS} rows in this scope; narrow the query`
    );
  }

  const declaration = columns
    .map((c) => (c.type ? `${quoteIdent(c.name)} ${c.type}` : quoteIdent(c.name)))
    .join(', ');
  scratch.exec(`CREATE TABLE ${table} (${declaration})`);
  copySourceIndexes(source, scratch, config.tableName, names[0]);
  if (rows.length === 0) return;

  const targets = withRowid ? ['rowid', ...names] : names;
  const insert = scratch.query(
    `INSERT INTO ${table} (${targets.map(quoteIdent).join(', ')}) VALUES (${targets.map(() => '?').join(', ')})`
  );
  enableBigInts(insert);
  scratch.exec('BEGIN');
  try {
    for (const row of rows) {
      const values = names.map((c) => row[c]);
      insert.run(...((withRowid ? [row._dbq_rowid, ...values] : values) as []));
    }
    scratch.exec('COMMIT');
  } catch (err) {
    scratch.exec('ROLLBACK');
    throw err;
  }
}

export function runScopedQuery(
  db: Database,
  scopeType: DbScopeType,
  scopeValue: string,
  query: ScopedDbQuery
): ScopedDbQueryResult {
  const { sql, params = [], limit } = query;

  const validation = validateSql(sql);
  if (!validation.valid) {
    throw new Error(validation.error ?? 'Invalid SQL');
  }

  const configs = getScopeConfig(scopeType);
  const configMap = new Map(configs.map((tc) => [tc.tableName, tc]));

  for (const tableRef of validation.tableRefs) {
    if (!configMap.has(tableRef)) {
      throw new Error(`Table "${tableRef}" is not accessible in ${scopeType} scope`);
    }
  }

  const cappedLimit = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const { sql: strippedSql, userLimit: existingLimit } = stripLimit(sql);
  const effectiveLimit = Math.min(cappedLimit, existingLimit ?? MAX_LIMIT);

  const scratch = new Database(':memory:');
  scratch.exec('PRAGMA case_sensitive_like = ON');
  try {
    db.exec('BEGIN DEFERRED');
    try {
      for (const tableRef of new Set(validation.tableRefs)) {
        const config = configMap.get(tableRef);
        if (config) materializeScopedTable(db, scratch, config, scopeValue);
      }
    } finally {
      db.exec('COMMIT');
    }

    const rows = scratch
      .query(`SELECT * FROM (${strippedSql}) LIMIT ${effectiveLimit}`)
      .all(...(params as [])) as Record<string, unknown>[];

    return { rows, rowCount: rows.length, truncated: rows.length >= effectiveLimit };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Query execution error: ${message}`);
  } finally {
    scratch.close();
  }
}
