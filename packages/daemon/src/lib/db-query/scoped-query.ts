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

function readableColumns(db: Database, config: ScopeTableConfig): string[] {
  const info = db.query(`PRAGMA table_info(${quoteIdent(config.tableName)})`).all() as Array<{
    name: string;
  }>;
  const blacklisted = new Set(config.blacklistedColumns);
  return info.map((c) => c.name).filter((name) => !blacklisted.has(name));
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
  const projection = columns.map(quoteIdent).join(', ');
  const rows = source
    .query(
      `SELECT ${projection} FROM ${quoteIdent(config.tableName)}${where} LIMIT ${MAX_MATERIALIZED_ROWS + 1}`
    )
    .all(...(filter.params as [])) as Record<string, unknown>[];

  if (rows.length > MAX_MATERIALIZED_ROWS) {
    throw new Error(
      `Table "${config.tableName}" holds more than ${MAX_MATERIALIZED_ROWS} rows in this scope; narrow the query`
    );
  }

  scratch.exec(`CREATE TABLE ${quoteIdent(config.tableName)} (${projection})`);
  if (rows.length === 0) return;

  const placeholders = columns.map(() => '?').join(', ');
  const insert = scratch.query(
    `INSERT INTO ${quoteIdent(config.tableName)} VALUES (${placeholders})`
  );
  scratch.exec('BEGIN');
  try {
    for (const row of rows) {
      insert.run(...(columns.map((c) => row[c]) as []));
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
  try {
    for (const tableRef of new Set(validation.tableRefs)) {
      const config = configMap.get(tableRef);
      if (config) materializeScopedTable(db, scratch, config, scopeValue);
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
