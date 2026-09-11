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

function getCteColumnListRanges(sql: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const upper = sql.toUpperCase();
  const len = sql.length;

  if (!/^\s*WITH\b/i.test(sql)) return ranges;

  let pos = sql.search(/\bWITH\b/i) + 4;

  while (pos < len && /\s/.test(sql[pos])) pos++;

  if (pos + 8 <= len && upper.slice(pos, pos + 9) === 'RECURSIVE') {
    pos += 9;
    while (pos < len && /\s/.test(sql[pos])) pos++;
  }

  while (pos < len) {
    const nameStart = pos;
    while (pos < len && /[\p{L}\p{N}_]/u.test(sql[pos])) pos++;
    if (pos === nameStart) break;

    while (pos < len && /\s/.test(sql[pos])) pos++;

    let hasColumnList = false;
    if (pos < len && sql[pos] === '(') {
      const savedPos = pos;
      let depth = 1;
      pos++;
      while (pos < len && depth > 0) {
        if (sql[pos] === '(') depth++;
        else if (sql[pos] === ')') depth--;
        pos++;
      }
      while (pos < len && /\s/.test(sql[pos])) pos++;
      if (pos + 1 < len && upper.slice(pos, pos + 2) === 'AS') {
        hasColumnList = true;
      } else {
        pos = savedPos;
      }
    }

    while (pos < len && /\s/.test(sql[pos])) pos++;

    if (pos + 1 < len && upper.slice(pos, pos + 2) === 'AS') {
      pos += 2;
    } else {
      break;
    }

    while (pos < len && /\s/.test(sql[pos])) pos++;

    if (pos < len && sql[pos] === '(') {
      const bodyStart = pos;
      let depth = 1;
      pos++;
      while (pos < len && depth > 0) {
        if (sql[pos] === "'") {
          pos++;
          while (pos < len) {
            if (sql[pos] === "'" && pos + 1 < len && sql[pos + 1] === "'") {
              pos += 2;
            } else if (sql[pos] === "'") {
              pos++;
              break;
            } else {
              pos++;
            }
          }
        } else if (sql[pos] === '(') {
          depth++;
          pos++;
        } else if (sql[pos] === ')') {
          depth--;
          pos++;
        } else {
          pos++;
        }
      }
      const bodyEnd = pos;

      if (hasColumnList) {
        ranges.push([bodyStart, bodyEnd]);
      }
    }

    while (pos < len && /\s/.test(sql[pos])) pos++;

    if (pos < len && sql[pos] === ',') {
      pos++;
      while (pos < len && /\s/.test(sql[pos])) pos++;
    } else {
      break;
    }
  }

  return ranges;
}

function rewriteSelectToStar(sql: string, options?: { skipOutermost?: boolean }): string {
  const cteRanges = getCteColumnListRanges(sql);

  const { skipOutermost = false } = options ?? {};

  const pairs: Array<{
    selectStart: number;
    fromStart: number;
    hasDistinct: boolean;
    depth: number;
  }> = [];
  const upper = sql.toUpperCase();
  let depth = 0;
  let inString = false;

  function isInCteRange(pos: number): boolean {
    return cteRanges.some(([start, end]) => pos >= start && pos < end);
  }

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

    if (
      upper.slice(i, i + 6) === 'SELECT' &&
      (i === 0 || /\s/.test(sql[i - 1]) || sql[i - 1] === '(')
    ) {
      const afterChar = i + 6 < sql.length ? sql[i + 6] : ' ';
      if (/\s/.test(afterChar) || afterChar === '(') {
        const selectEnd = i + 6;
        const targetDepth = depth;

        const afterSelect = sql.slice(selectEnd).trimStart();
        const hasDistinct = /^DISTINCT\b/i.test(afterSelect);

        let fDepth = depth;
        let fInString = false;
        let fromStart = -1;
        for (let j = selectEnd; j < sql.length; j++) {
          const c = sql[j];
          if (fInString) {
            if (c === "'" && j + 1 < sql.length && sql[j + 1] === "'") {
              j++;
              continue;
            }
            if (c === "'") fInString = false;
            continue;
          }
          if (c === "'") {
            fInString = true;
            continue;
          }
          if (c === '(') fDepth++;
          if (c === ')') fDepth--;
          if (fDepth !== targetDepth) continue;
          if (
            upper.slice(j, j + 4) === 'FROM' &&
            (j === 0 || /\s/.test(sql[j - 1])) &&
            (j + 4 >= sql.length || /\s/.test(sql[j + 4]))
          ) {
            fromStart = j;
            break;
          }
        }
        if (fromStart !== -1 && !isInCteRange(i)) {
          pairs.push({ selectStart: i, fromStart, hasDistinct, depth: targetDepth });
        }
      }
    }
  }

  const nonSubqueryPairs = pairs.filter((pair) => {
    for (const other of pairs) {
      if (other === pair) continue;
      if (
        other.depth < pair.depth &&
        pair.selectStart > other.selectStart &&
        pair.selectStart < other.fromStart
      ) {
        return false;
      }
    }
    return true;
  });

  const activePairs = skipOutermost
    ? nonSubqueryPairs.filter((p) => p.depth > 0)
    : nonSubqueryPairs;
  if (activePairs.length === 0) return sql;

  let result = sql;
  for (let p = activePairs.length - 1; p >= 0; p--) {
    const { selectStart, fromStart, hasDistinct } = activePairs[p];
    const replacement = hasDistinct ? 'SELECT DISTINCT * ' : 'SELECT * ';
    result = `${result.slice(0, selectStart)}${replacement}${result.slice(fromStart)}`;
  }

  return result;
}

function stripLimit(sql: string): { sql: string; userLimit?: number } {
  const limitPos = findTopLevelKeyword(sql, 'LIMIT');
  if (limitPos === -1) return { sql };

  const afterLimit = sql.slice(limitPos + 5).trim();
  const match = afterLimit.match(/^(\d+)/);
  const userLimit = match ? Number.parseInt(match[1], 10) : undefined;

  return { sql: sql.slice(0, limitPos).trimEnd(), userLimit };
}

function isAggregateOrDistinctQuery(sql: string): boolean {
  if (findTopLevelKeyword(sql, 'GROUP BY') !== -1) return true;

  if (findTopLevelKeyword(sql, 'HAVING') !== -1) return true;

  const selectPos = findTopLevelKeyword(sql, 'SELECT');
  if (selectPos !== -1) {
    const afterSelect = sql.slice(selectPos + 6).trimStart();
    if (/^DISTINCT\b/i.test(afterSelect)) return true;
  }

  const fromPos = findTopLevelKeyword(sql, 'FROM');

  if (selectPos !== -1 && fromPos !== -1) {
    const columnList = sql.slice(selectPos + 6, fromPos);
    if (/\(\s*SELECT\b/i.test(columnList)) return true;
  }

  if (selectPos === -1 || fromPos === -1 || fromPos <= selectPos) return false;

  const aggColumnList = sql.slice(selectPos + 6, fromPos).toUpperCase();
  const aggFunctions = ['COUNT(', 'SUM(', 'AVG(', 'MIN(', 'MAX(', 'GROUP_CONCAT(', 'TOTAL('];
  return aggFunctions.some((fn) => aggColumnList.includes(fn));
}

function maskQuotedIdentifiers(sql: string): string {
  return sql.replace(/\[[^\]]*\]|"[^"]*"|`[^`]*`/g, (match) => ' '.repeat(match.length));
}

const UNSUPPORTED_CONSTRUCTS: Array<[RegExp, string]> = [
  [
    /\?\d|[:@$][\p{L}_]/u,
    'numbered or named parameters are not supported; use plain ? placeholders',
  ],
  [/\b(?:indexed\s+by|not\s+indexed)\b/i, 'index hints are not supported in scoped queries'],
  [/\b(?:rowid|oid|_rowid_)\b/i, 'row identifier columns are not available in scoped queries'],
];

function assertRewritableSql(sql: string): void {
  const masked = maskQuotedIdentifiers(maskCommentsAndStrings(sql));
  for (const [pattern, reason] of UNSUPPORTED_CONSTRUCTS) {
    if (pattern.test(masked)) throw new Error(`Query cannot be scoped: ${reason}`);
  }
}

const ALIAS_STOP_WORDS = new Set(
  'join left right inner outer cross natural on using where group order limit having window union except intersect'.split(
    ' '
  )
);

function hasFollowingAlias(masked: string, end: number): boolean {
  let i = end;
  while (i < masked.length && /\s/.test(masked[i])) i++;
  if (i >= masked.length) return false;
  if (masked[i] === "'" || masked[i] === '"' || masked[i] === '[' || masked[i] === '`') return true;
  const word = /^[\p{L}_][\p{L}\p{N}_$]*/u.exec(masked.slice(i));
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
): { sql: string; params: unknown[]; applied: boolean } {
  const masked = maskQuotedIdentifiers(maskCommentsAndStrings(sql));
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
  return { sql: out, params, applied: cursor > 0 };
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
  const { sql: strippedSql, userLimit: existingLimit } = stripLimit(sql);
  const effectiveLimit = Math.min(cappedLimit, existingLimit ?? MAX_LIMIT);
  const aggregate = isAggregateOrDistinctQuery(strippedSql);
  const probe = applyTableScopeFilters(strippedSql, userParams, tableConfigs, scopeValue);

  if (!probe.applied) {
    return {
      sql: `${strippedSql} LIMIT ${effectiveLimit}`,
      params: userParams,
      cappedLimit: effectiveLimit,
    };
  }

  const scoped = aggregate
    ? probe
    : applyTableScopeFilters(
        rewriteSelectToStar(strippedSql),
        userParams,
        tableConfigs,
        scopeValue
      );

  if (aggregate) {
    return {
      sql: `${scoped.sql} LIMIT ${effectiveLimit}`,
      params: scoped.params,
      cappedLimit: effectiveLimit,
    };
  }

  return {
    sql: `SELECT * FROM (${scoped.sql}) AS _dbq LIMIT ${effectiveLimit}`,
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
      if (!blacklisted.has(key.replace(/:\d+$/, ''))) {
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

  assertRewritableSql(sql);

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
