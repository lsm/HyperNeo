import type { Database } from '../../storage/sqlite-compat.ts';
import { type DbScopeType, type ScopeTableConfig, getScopeConfig } from './scope-config.ts';
import { extractTableRefSpans, maskCommentsAndStrings, validateSql } from './sql-validator.ts';

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

const ALIAS_STOP_WORDS = new Set([
  'join',
  'left',
  'right',
  'inner',
  'outer',
  'cross',
  'natural',
  'on',
  'using',
  'where',
  'group',
  'order',
  'limit',
  'having',
  'window',
  'union',
  'except',
  'intersect',
]);

function hasFollowingAlias(masked: string, end: number): boolean {
  let i = end;
  while (i < masked.length && /\s/.test(masked[i])) i++;
  if (i >= masked.length) return false;
  if (masked[i] === "'" || masked[i] === '"' || masked[i] === '[' || masked[i] === '`') return true;
  const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(masked.slice(i));
  if (!word) return false;
  const lower = word[0].toLowerCase();
  if (lower === 'as') return true;
  return !ALIAS_STOP_WORDS.has(lower);
}

function buildTableScopeFilter(
  config: ScopeTableConfig,
  scopeValue: string
): { whereClause: string; params: unknown[] } {
  if (config.scopeColumn) {
    return { whereClause: `${config.scopeColumn} = ?`, params: [scopeValue] };
  }

  if (config.scopeLike) {
    const { column, patternPrefix, patternSuffix } = config.scopeLike;
    return {
      whereClause: `${column} LIKE ?`,
      params: [`${patternPrefix}${scopeValue}${patternSuffix}`],
    };
  }

  if (config.scopeJoin) {
    const join = config.scopeJoin;
    const inner = `${join.localColumn} IN (SELECT ${join.joinPkColumn} FROM ${join.joinTable} WHERE ${join.scopeColumn}`;
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

function applyTableScopeFilters(
  sql: string,
  userParams: unknown[],
  tableConfigs: Map<string, ScopeTableConfig>,
  scopeValue: string
): { sql: string; params: unknown[] } {
  const masked = maskCommentsAndStrings(sql);
  let out = '';
  let cursor = 0;
  let paramCursor = 0;
  const params: unknown[] = [];

  for (const span of extractTableRefSpans(sql)) {
    const config = tableConfigs.get(span.name);
    if (!config) continue;
    const filter = buildTableScopeFilter(config, scopeValue);
    if (!filter.whereClause) continue;

    const consumed = (masked.slice(cursor, span.start).match(/\?/g) ?? []).length;
    params.push(...userParams.slice(paramCursor, paramCursor + consumed));
    paramCursor += consumed;

    const alias = hasFollowingAlias(masked, span.end) ? '' : ` ${span.name}`;
    out += sql.slice(cursor, span.start);
    out += `(SELECT * FROM ${sql.slice(span.start, span.end)} WHERE ${filter.whereClause})${alias}`;
    params.push(...filter.params);
    cursor = span.end;
  }

  out += sql.slice(cursor);
  params.push(...userParams.slice(paramCursor));
  return { sql: out, params };
}

function rewriteScopedQuery(
  sql: string,
  userParams: unknown[],
  scopeType: DbScopeType,
  scopeValue: string,
  tableConfigs: Map<string, ScopeTableConfig>,
  userLimit?: number
): { sql: string; params: unknown[]; cappedLimit: number } {
  const cappedLimit = Math.min(userLimit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const scoped = applyTableScopeFilters(sql, userParams, tableConfigs, scopeValue);
  const { sql: strippedSql, userLimit: existingLimit } = stripLimit(scoped.sql);
  const effectiveLimit = Math.min(cappedLimit, existingLimit ?? MAX_LIMIT);

  return {
    sql: `SELECT * FROM (${strippedSql}) AS _dbq LIMIT ${effectiveLimit}`,
    params: scoped.params,
    cappedLimit: effectiveLimit,
  };
}

function removeBlacklistedColumns(
  rows: Record<string, unknown>[],
  tableConfigs: Map<string, ScopeTableConfig>
): Record<string, unknown>[] {
  const blacklisted = new Set<string>();
  for (const config of tableConfigs.values()) {
    for (const col of config.blacklistedColumns) {
      blacklisted.add(col);
    }
  }

  if (blacklisted.size === 0) return rows;

  return rows.map((row) => {
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!blacklisted.has(key)) {
        filtered[key] = value;
      }
    }
    return filtered;
  });
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

  const configMap = new Map<string, ScopeTableConfig>();
  for (const tc of getScopeConfig(scopeType)) {
    configMap.set(tc.tableName, tc);
  }

  for (const tableRef of validation.tableRefs) {
    if (!configMap.has(tableRef)) {
      throw new Error(`Table "${tableRef}" is not accessible in ${scopeType} scope`);
    }
  }

  const tableConfigs = new Map<string, ScopeTableConfig>();
  for (const tableRef of validation.tableRefs) {
    const tc = configMap.get(tableRef);
    if (tc) tableConfigs.set(tableRef, tc);
  }

  const {
    sql: wrappedSql,
    params: allParams,
    cappedLimit,
  } = rewriteScopedQuery(sql, params, scopeType, scopeValue, tableConfigs, limit);

  try {
    const stmt = db.query(wrappedSql);
    const rows = stmt.all(...(allParams as [])) as Record<string, unknown>[];

    const filteredRows = removeBlacklistedColumns(rows, tableConfigs);

    const truncated = rows.length >= cappedLimit;

    return {
      rows: filteredRows,
      rowCount: filteredRows.length,
      truncated,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Query execution error: ${message}`);
  }
}
