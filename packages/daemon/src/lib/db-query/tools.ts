/**
 * db-query MCP Server — scoped read-only SQL access for agent sessions.
 *
 * Provides three tools: db_query, db_list_tables, db_describe_table.
 * Each instance owns a single read-only SQLite connection created at init
 * and closed via the returned close() method.
 *
 * Scope enforcement is layered:
 *   1. SQL validation rejects non-SELECT statements (fast feedback)
 *   2. Table-ref validation rejects queries referencing out-of-scope tables
 *   3. Subquery wrapping injects WHERE clauses for room/space scopes
 *   4. Connection-level read-only mode (readonly: true + PRAGMA query_only = ON)
 *   5. Row limit cap (default 200, max 1000)
 *   6. Column blacklist removes sensitive columns from results
 */

import { Database } from '../../storage/sqlite-compat';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { type DbScopeType, type ScopeTableConfig, getScopeConfig } from './scope-config.ts';
import { validateSql } from './sql-validator.ts';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DbQueryToolsConfig {
  dbPath: string;
  scopeType: DbScopeType;
  scopeValue: string;
}

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
}

interface DbQueryMcpServer {
  type: 'sdk';
  name: string;
  version?: string;
  tools?: unknown[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  instance: any;
  close(): void;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

// ============ SQL Parsing Helpers ============

/**
 * Find the position of a top-level SQL keyword, respecting parentheses
 * depth and single-quoted string literals.
 */
function findTopLevelKeyword(sql: string, keyword: string): number {
  const upper = sql.toUpperCase();
  const kwLen = keyword.length;
  let depth = 0;
  let inString = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (inString) {
      if (ch === "'" && i + 1 < sql.length && sql[i + 1] === "'") {
        i++; // skip escaped quote
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

/**
 * Find character ranges of CTE bodies that declare explicit column lists.
 * SELECTs inside these ranges must NOT be rewritten to * because the
 * column count must match the declared CTE columns.
 *
 * Example:
 *   WITH t(a, b) AS (SELECT x, y FROM ...) SELECT * FROM t
 *                    ^^^^^^^^^^^^^^^^^^^^^^^  — this range is excluded
 *
 * Returns sorted array of [start, end) half-open ranges (start inclusive, end exclusive).
 */
function getCteColumnListRanges(sql: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const upper = sql.toUpperCase();
  const len = sql.length;

  // Must start with WITH
  if (!/^\s*WITH\b/i.test(sql)) return ranges;

  let pos = sql.search(/\bWITH\b/i) + 4;

  // Skip whitespace
  while (pos < len && /\s/.test(sql[pos])) pos++;

  // Skip optional RECURSIVE
  if (pos + 8 <= len && upper.slice(pos, pos + 9) === 'RECURSIVE') {
    pos += 9;
    while (pos < len && /\s/.test(sql[pos])) pos++;
  }

  while (pos < len) {
    // Read CTE name (identifier)
    const nameStart = pos;
    while (pos < len && /[\p{L}\p{N}_]/u.test(sql[pos])) pos++;
    if (pos === nameStart) break;

    // Skip whitespace
    while (pos < len && /\s/.test(sql[pos])) pos++;

    // Check for optional column list: name(c1, c2) AS (body)
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
      // Skip whitespace after closing paren
      while (pos < len && /\s/.test(sql[pos])) pos++;
      // If followed by AS, this was a column list
      if (pos + 1 < len && upper.slice(pos, pos + 2) === 'AS') {
        hasColumnList = true;
      } else {
        // Not a column list — backtrack
        pos = savedPos;
      }
    }

    // Skip whitespace
    while (pos < len && /\s/.test(sql[pos])) pos++;

    // Expect AS keyword
    if (pos + 1 < len && upper.slice(pos, pos + 2) === 'AS') {
      pos += 2;
    } else {
      break;
    }

    // Skip whitespace
    while (pos < len && /\s/.test(sql[pos])) pos++;

    // Expect ( for CTE body
    if (pos < len && sql[pos] === '(') {
      const bodyStart = pos; // include the opening (
      let depth = 1;
      pos++;
      while (pos < len && depth > 0) {
        if (sql[pos] === "'") {
          // Skip string literal, handling '' escaped quotes
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
      const bodyEnd = pos; // after the closing )

      if (hasColumnList) {
        ranges.push([bodyStart, bodyEnd]);
      }
    }

    // Skip whitespace
    while (pos < len && /\s/.test(sql[pos])) pos++;

    // Check for comma (more CTEs)
    if (pos < len && sql[pos] === ',') {
      pos++;
      while (pos < len && /\s/.test(sql[pos])) pos++;
    } else {
      break;
    }
  }

  return ranges;
}

/**
 * Rewrite ALL SELECT column lists to `*` so that all columns
 * (including scope columns needed by the outer filter) are available.
 * This handles both the main SELECT and SELECTs inside CTE bodies,
 * subqueries, and nested parentheses. Preserves DISTINCT when present.
 *
 * Strategy: collect all (selectPos, fromPos) pairs in a single forward pass
 * (at any depth, respecting string literals), then replace from right to
 * left to preserve string positions. The outer loop walks left-to-right, so
 * pairs are in ascending order by selectStart — this invariant is required
 * for the right-to-left replacement to be correct.
 */
function rewriteSelectToStar(sql: string, options?: { skipOutermost?: boolean }): string {
  // Pre-compute ranges of CTE bodies that have explicit column lists.
  // SELECTs inside these ranges must not be rewritten because the column
  // count must match the declared CTE columns.
  const cteRanges = getCteColumnListRanges(sql);

  // Collect all SELECT→FROM pairs at any depth (except inside string literals
  // and CTE bodies with explicit column lists).
  // Each pair records selectStart (position of S in SELECT), fromStart
  // (position of F in FROM), and whether DISTINCT follows SELECT.
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

    // Check for SELECT keyword at any depth (CTE bodies, subqueries, etc.)
    if (
      upper.slice(i, i + 6) === 'SELECT' &&
      (i === 0 || /\s/.test(sql[i - 1]) || sql[i - 1] === '(')
    ) {
      const afterChar = i + 6 < sql.length ? sql[i + 6] : ' ';
      if (/\s/.test(afterChar) || afterChar === '(') {
        const selectEnd = i + 6;
        const targetDepth = depth;

        // Check for DISTINCT keyword immediately after SELECT
        const afterSelect = sql.slice(selectEnd).trimStart();
        const hasDistinct = /^DISTINCT\b/i.test(afterSelect);

        // Find matching FROM at the same depth as this SELECT
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

  // Post-processing: skip SELECTs inside column-list subqueries.
  // A SELECT at depth D is a column-list subquery when its position falls
  // between another SELECT's selectStart and fromStart at a shallower depth.
  // Rewriting these would change scalar subqueries to potentially return
  // multiple columns, breaking the query.
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

  // Filter out outermost SELECTs when skipOutermost is true (for aggregate/DISTINCT queries)
  const activePairs = skipOutermost
    ? nonSubqueryPairs.filter((p) => p.depth > 0)
    : nonSubqueryPairs;
  if (activePairs.length === 0) return sql;

  // Replace from right to left to preserve positions. Active pairs are in ascending
  // order by selectStart (outer loop walks left-to-right), so processing
  // right-to-left ensures earlier positions remain valid after each replacement.
  // No shift tracking is needed — positions to the LEFT of a replaced range
  // are unchanged by right-to-left processing.
  let result = sql;
  for (let p = activePairs.length - 1; p >= 0; p--) {
    const { selectStart, fromStart, hasDistinct } = activePairs[p];
    const replacement = hasDistinct ? 'SELECT DISTINCT * ' : 'SELECT * ';
    result = `${result.slice(0, selectStart)}${replacement}${result.slice(fromStart)}`;
  }

  return result;
}

/**
 * Strip the user's LIMIT clause from the end of a SQL statement.
 * Returns the SQL without LIMIT and the user-specified limit value (if any).
 */
function stripLimit(sql: string): { sql: string; userLimit?: number } {
  const limitPos = findTopLevelKeyword(sql, 'LIMIT');
  if (limitPos === -1) return { sql };

  const afterLimit = sql.slice(limitPos + 5).trim();
  const match = afterLimit.match(/^(\d+)/);
  const userLimit = match ? Number.parseInt(match[1], 10) : undefined;

  return { sql: sql.slice(0, limitPos).trimEnd(), userLimit };
}

/**
 * Strip the user's top-level ORDER BY clause from a SQL statement.
 * Returns the SQL without ORDER BY and the extracted clause (if any).
 * Only strips ORDER BY at the top level (depth 0), preserving ORDER BY
 * inside CTE bodies and subqueries.
 */
function stripOrderBy(sql: string): { sql: string; orderBy?: string } {
  const pos = findTopLevelKeyword(sql, 'ORDER BY');
  if (pos === -1) return { sql };

  const orderBy = sql.slice(pos).trimEnd();
  return { sql: sql.slice(0, pos).trimEnd(), orderBy };
}

/**
 * Detect whether a SQL query is an aggregate or DISTINCT query.
 * Aggregate queries use GROUP BY, HAVING, or aggregate functions
 * (COUNT, SUM, AVG, MIN, MAX) in the outermost SELECT's column list.
 * DISTINCT queries use the DISTINCT keyword in the outermost SELECT.
 *
 * These queries cannot use the subquery wrapper approach because
 * rewriting SELECT columns to * would destroy the aggregate/DISTINCT
 * semantics. Instead, scope filters are injected directly into the query.
 */
function isAggregateOrDistinctQuery(sql: string): boolean {
  // Check for GROUP BY at top level
  if (findTopLevelKeyword(sql, 'GROUP BY') !== -1) return true;

  // Check for HAVING at top level
  if (findTopLevelKeyword(sql, 'HAVING') !== -1) return true;

  // Check for DISTINCT keyword after the top-level SELECT
  const selectPos = findTopLevelKeyword(sql, 'SELECT');
  if (selectPos !== -1) {
    const afterSelect = sql.slice(selectPos + 6).trimStart();
    if (/^DISTINCT\b/i.test(afterSelect)) return true;
  }

  // Find the top-level FROM position (used for subquery and aggregate detection)
  const fromPos = findTopLevelKeyword(sql, 'FROM');

  // Check for subqueries in the column list. These cannot be handled
  // by the subquery wrapper (rewriteSelectToStar would destroy them),
  // so they must go through the direct WHERE injection path.
  if (selectPos !== -1 && fromPos !== -1) {
    const columnList = sql.slice(selectPos + 6, fromPos);
    if (/\(\s*SELECT\b/i.test(columnList)) return true;
  }

  // Check for aggregate functions in the outermost SELECT's column list
  // (between the top-level SELECT and the top-level FROM).
  // Note: this does NOT skip parenthesized subqueries — the raw column list
  // text is scanned. False positives from correlated subqueries like
  // `SELECT (SELECT COUNT(*) FROM t) AS cnt FROM ...` are prevented by the
  // `/\(\s*SELECT\b/i` guard above, which short-circuits before reaching here.
  if (selectPos === -1 || fromPos === -1 || fromPos <= selectPos) return false;

  const aggColumnList = sql.slice(selectPos + 6, fromPos).toUpperCase();
  const aggFunctions = ['COUNT(', 'SUM(', 'AVG(', 'MIN(', 'MAX(', 'GROUP_CONCAT(', 'TOTAL('];
  return aggFunctions.some((fn) => aggColumnList.includes(fn));
}

/**
 * Find the position of the first top-level clause boundary keyword
 * (GROUP BY, HAVING, ORDER BY) in the SQL. Returns sql.length if none found.
 * Used to determine where to insert WHERE clauses.
 */
function findTopLevelBoundary(sql: string): number {
  const keywords = ['GROUP BY', 'HAVING', 'ORDER BY'];
  let earliest = sql.length;

  for (const kw of keywords) {
    const pos = findTopLevelKeyword(sql, kw);
    if (pos !== -1 && pos < earliest) {
      earliest = pos;
    }
  }

  return earliest;
}

/**
 * Inject a WHERE clause into a SQL query.
 * Handles both queries with and without an existing WHERE clause.
 * The clause is inserted before GROUP BY, HAVING, or ORDER BY (whichever comes first).
 */
function injectWhereClause(sql: string, whereClause: string): string {
  const wherePos = findTopLevelKeyword(sql, 'WHERE');

  if (wherePos !== -1) {
    // Query has WHERE — append AND before the next boundary keyword
    const boundary = findTopLevelBoundary(sql);
    return `${sql.slice(0, boundary)} AND ${whereClause}${sql.slice(boundary)}`;
  }

  // No WHERE — insert before GROUP BY, HAVING, ORDER BY, or at the end
  const insertPos = findTopLevelBoundary(sql);

  if (insertPos < sql.length) {
    return `${sql.slice(0, insertPos)} WHERE ${whereClause} ${sql.slice(insertPos)}`;
  }

  return `${sql} WHERE ${whereClause}`;
}

// ============ Scope Filter Builder ============

/**
 * Build a parameterized WHERE clause for a scoped table, using the `_dbq.` prefix
 * for column references that belong to the outer wrapper table.
 */
function buildPrefixedScopeFilter(
  config: ScopeTableConfig,
  scopeValue: string
): { whereClause: string; params: unknown[] } {
  // No scope column, join, or like — no filter needed (global tables)
  if (!config.scopeColumn && !config.scopeJoin && !config.scopeLike) {
    return { whereClause: '', params: [] };
  }

  // Direct scope filter
  if (config.scopeColumn) {
    return {
      whereClause: `_dbq.${config.scopeColumn} = ?`,
      params: [scopeValue],
    };
  }

  // LIKE-based direct scope filter (e.g., session ID prefix matching).
  // No LIKE-escaping of scopeValue is needed: it is always a server-side
  // crypto.randomUUID() string set in the MCP server closure before any agent
  // interaction, so it can never contain the LIKE special chars '%' or '_'.
  if (config.scopeLike) {
    const { column, patternPrefix, patternSuffix } = config.scopeLike;
    return {
      whereClause: `_dbq.${column} LIKE ?`,
      params: [`${patternPrefix}${scopeValue}${patternSuffix}`],
    };
  }

  // Indirect scope filter via join table
  if (config.scopeJoin) {
    const join = config.scopeJoin;
    if (join.likePrefix !== undefined) {
      // LIKE-based join: e.g., session_groups scoped via session_group_members.session_id
      return {
        whereClause: `_dbq.${join.localColumn} IN (SELECT ${join.joinPkColumn} FROM ${join.joinTable} WHERE ${join.scopeColumn} LIKE ?)`,
        params: [`${join.likePrefix}${scopeValue}${join.likeSuffix ?? ''}`],
      };
    }
    return {
      whereClause: `_dbq.${join.localColumn} IN (SELECT ${join.joinPkColumn} FROM ${join.joinTable} WHERE ${join.scopeColumn} = ?)`,
      params: [scopeValue],
    };
  }

  return { whereClause: '', params: [] };
}

/**
 * Rewrite a validated SELECT query with scope filter injection.
 *
 * Strategy:
 *   - Global scope (no filters): append LIMIT cap to the original SQL.
 *   - Aggregate/DISTINCT queries: inject scope filters directly into the
 *     query's WHERE clause. Rewriting SELECT to * would destroy aggregate
 *     or DISTINCT semantics. CTE bodies (without explicit column lists) are
 *     still rewritten to * so scope columns flow through to the main query.
 *   - Regular queries in room/space scope: wrap as a subquery aliased `_dbq`,
 *     then apply combined scope filters in the outer WHERE clause. The inner
 *     query's SELECT is rewritten to `*` so scope columns are available.
 *     ORDER BY is moved from the inner query to the outer wrapper.
 */
function rewriteScopedQuery(
  sql: string,
  userParams: unknown[],
  scopeType: DbScopeType,
  scopeValue: string,
  tableConfigs: Map<string, ScopeTableConfig>,
  userLimit?: number
): { sql: string; params: unknown[]; cappedLimit: number } {
  const cappedLimit = Math.min(userLimit ?? DEFAULT_LIMIT, MAX_LIMIT);

  // Build scope filters for all referenced tables, deduplicating identical
  // clauses to avoid ambiguous column references when multiple tables share
  // the same scope column (e.g. tasks JOIN goals both have room_id).
  const scopeFilterSet = new Map<string, unknown[]>();
  for (const config of tableConfigs.values()) {
    const filter = buildPrefixedScopeFilter(config, scopeValue);
    if (filter.whereClause && !scopeFilterSet.has(filter.whereClause)) {
      scopeFilterSet.set(filter.whereClause, filter.params);
    }
  }

  // No scope filters needed (global scope, all tables unscoped, or no table refs
  // e.g. SELECT 1). Table-less queries are safe to pass through — they don't
  // access any scoped data.
  if (scopeFilterSet.size === 0) {
    const { sql: strippedSql, userLimit: existingLimit } = stripLimit(sql);
    // Use the stricter of the arg-level limit and the SQL-embedded limit
    const effectiveLimit = Math.min(cappedLimit, existingLimit ?? MAX_LIMIT);
    return {
      sql: `${strippedSql} LIMIT ${effectiveLimit}`,
      params: userParams,
      cappedLimit: effectiveLimit,
    };
  }

  // Strip user's LIMIT and honor it alongside the arg-level limit
  const { sql: strippedSql, userLimit: existingLimit } = stripLimit(sql);
  const effectiveLimit = Math.min(cappedLimit, existingLimit ?? MAX_LIMIT);
  const scopeParams = [...scopeFilterSet.values()].flat();

  // Aggregate/DISTINCT queries: inject scope filter directly into the query.
  // Rewriting SELECT to * would destroy aggregate/DISTINCT semantics.
  // ORDER BY is preserved naturally — injectWhereClause inserts before it.
  if (isAggregateOrDistinctQuery(strippedSql)) {
    // Rewrite inner SELECTs (CTE bodies, subqueries) to * so scope columns
    // flow through, but skip the outermost SELECT which contains the aggregate.
    const innerRewritten = rewriteSelectToStar(strippedSql, { skipOutermost: true });

    // Build direct scope filters (without _dbq. prefix) using unqualified
    // column names. Deduplicate identical clauses.
    const directFilters = new Map<string, unknown[]>();
    for (const config of tableConfigs.values()) {
      if (config.scopeColumn) {
        const clause = `${config.scopeColumn} = ?`;
        if (!directFilters.has(clause)) {
          directFilters.set(clause, [scopeValue]);
        }
      }
      if (config.scopeLike) {
        const { column, patternPrefix, patternSuffix } = config.scopeLike;
        const clause = `${column} LIKE ?`;
        if (!directFilters.has(clause)) {
          directFilters.set(clause, [`${patternPrefix}${scopeValue}${patternSuffix}`]);
        }
      }
      if (config.scopeJoin) {
        const join = config.scopeJoin;
        if (join.likePrefix !== undefined) {
          const clause = `${join.localColumn} IN (SELECT ${join.joinPkColumn} FROM ${join.joinTable} WHERE ${join.scopeColumn} LIKE ?)`;
          if (!directFilters.has(clause)) {
            directFilters.set(clause, [`${join.likePrefix}${scopeValue}${join.likeSuffix ?? ''}`]);
          }
        } else {
          const clause = `${join.localColumn} IN (SELECT ${join.joinPkColumn} FROM ${join.joinTable} WHERE ${join.scopeColumn} = ?)`;
          if (!directFilters.has(clause)) {
            directFilters.set(clause, [scopeValue]);
          }
        }
      }
    }

    let filteredSql = innerRewritten;
    const directParams: unknown[] = [];
    if (directFilters.size > 0) {
      const combinedClause = [...directFilters.keys()].join(' AND ');
      filteredSql = injectWhereClause(innerRewritten, combinedClause);
      directParams.push(...[...directFilters.values()].flat());
    }

    return {
      sql: `${filteredSql} LIMIT ${effectiveLimit}`,
      params: [...userParams, ...directParams],
      cappedLimit: effectiveLimit,
    };
  }

  // Regular queries: subquery wrapping approach
  const combinedWhere = [...scopeFilterSet.keys()].join(' AND ');

  // Strip ORDER BY from the inner query — SQLite does not guarantee ordering
  // from subqueries, so ORDER BY must be on the outer wrapper.
  const { sql: noOrderBy, orderBy } = stripOrderBy(strippedSql);

  // Rewrite all SELECTs (including CTE bodies) to * for the inner query
  // so scope columns are available. The outer SELECT also uses * because
  // qualified column names (table.column) and aliases become invalid in
  // the subquery wrapper context — only _dbq is a valid table reference.
  const innerSql = rewriteSelectToStar(noOrderBy);

  const orderClause = orderBy ? ` ${orderBy}` : '';
  const wrappedSql = `SELECT * FROM (${innerSql}) AS _dbq WHERE ${combinedWhere}${orderClause} LIMIT ${effectiveLimit}`;

  return { sql: wrappedSql, params: [...userParams, ...scopeParams], cappedLimit: effectiveLimit };
}

/**
 * Remove blacklisted columns from query result rows.
 * Collects blacklists from all referenced tables and removes those keys.
 */
function removeBlacklistedColumns(
  rows: Record<string, unknown>[],
  tableConfigs: Map<string, ScopeTableConfig>
): Record<string, unknown>[] {
  // Collect all blacklisted column names across referenced tables
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

// ============ JSON helper ============

function jsonResult(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ============ Tool Handlers ============

/**
 * Create plain handler functions for the three db-query tools.
 * These can be tested directly without the SDK MCP server wrapper.
 */
export function createDbQueryToolHandlers(config: DbQueryToolsConfig, db: Database) {
  const { scopeType, scopeValue } = config;
  const scopeConfigs = getScopeConfig(scopeType);

  // Build lookup map for table configs
  const configMap = new Map<string, ScopeTableConfig>();
  for (const tc of scopeConfigs) {
    configMap.set(tc.tableName, tc);
  }

  return {
    async db_query(args: { sql: string; params?: unknown[]; limit?: number }): Promise<ToolResult> {
      const { sql, params = [], limit } = args;

      // Step 1: Validate SQL — reject if not a valid SELECT
      const validation = validateSql(sql);
      if (!validation.valid) {
        return errorResult(validation.error ?? 'Invalid SQL');
      }

      // Step 2: Check all tableRefs are within the current scope
      for (const tableRef of validation.tableRefs) {
        if (!configMap.has(tableRef)) {
          return errorResult(`Table "${tableRef}" is not accessible in ${scopeType} scope`);
        }
      }

      // Step 3: Build per-table scope filter configs
      const tableConfigs = new Map<string, ScopeTableConfig>();
      for (const tableRef of validation.tableRefs) {
        const tc = configMap.get(tableRef);
        if (tc) tableConfigs.set(tableRef, tc);
      }

      // Step 4-6: Rewrite query with scope filter wrapping and LIMIT cap
      const {
        sql: wrappedSql,
        params: allParams,
        cappedLimit,
      } = rewriteScopedQuery(sql, params, scopeType, scopeValue, tableConfigs, limit);

      // Step 7: Execute the rewritten query
      try {
        const stmt = db.query(wrappedSql);
        const rows = stmt.all(...(allParams as [])) as Record<string, unknown>[];

        // Step 8: Apply column blacklist
        const filteredRows = removeBlacklistedColumns(rows, tableConfigs);

        // Step 9: Return result — truncated is true when the result set
        // hit the applied LIMIT cap, meaning more rows may exist
        const truncated = rows.length >= cappedLimit;

        return jsonResult({
          rows: filteredRows,
          rowCount: filteredRows.length,
          truncated,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Query execution error: ${message}`);
      }
    },

    async db_list_tables(): Promise<ToolResult> {
      const lines: string[] = ['| Table | Description |', '|-------|-------------|'];
      for (const tc of scopeConfigs) {
        const blacklistNote =
          tc.blacklistedColumns.length > 0
            ? ` (${tc.blacklistedColumns.length} column(s) hidden)`
            : '';
        lines.push(`| ${tc.tableName} | ${tc.description}${blacklistNote} |`);
      }
      return jsonResult({
        tables: scopeConfigs.map((tc) => tc.tableName),
        description: lines.join('\n'),
      });
    },

    async db_describe_table(args: { table_name: string }): Promise<ToolResult> {
      const { table_name } = args;

      // Verify table is in current scope
      if (!configMap.has(table_name)) {
        return errorResult(`Table "${table_name}" is not accessible in ${scopeType} scope`);
      }

      const tableConfig = configMap.get(table_name)!;
      const blacklisted = new Set(tableConfig.blacklistedColumns);

      // Execute PRAGMA table_info — server-side, not user SQL.
      // PRAGMA does not support parameterized bindings, so the table name
      // is interpolated directly. The table_name has already been validated
      // against the scope config's accessible table names (alphanumeric + underscore).
      // Self-contained format guard: table names must be alphanumeric+underscore
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table_name)) {
        return errorResult(`Invalid table name: "${table_name}"`);
      }
      const columns = db.query(`PRAGMA table_info("${table_name}")`).all() as Array<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
        pk: number;
      }>;

      // Filter out blacklisted columns
      const visibleColumns = columns.filter((col) => !blacklisted.has(col.name));

      // Execute PRAGMA foreign_key_list
      const fks = db.query(`PRAGMA foreign_key_list("${table_name}")`).all() as Array<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
      }>;

      // Format output
      const parts: string[] = [];
      parts.push(`## ${table_name}`);
      parts.push('');
      parts.push(tableConfig.description);
      parts.push('');

      if (visibleColumns.length > 0) {
        parts.push('### Columns');
        parts.push('');
        parts.push('| Name | Type | Not Null | Default | PK |');
        parts.push('|------|------|----------|---------|----|');
        for (const col of visibleColumns) {
          const notNull = col.notnull ? 'YES' : 'no';
          const defaultVal = col.dflt_value !== null ? String(col.dflt_value) : '';
          const pk = col.pk ? `#${col.pk}` : '';
          parts.push(`| ${col.name} | ${col.type} | ${notNull} | ${defaultVal} | ${pk} |`);
        }
      } else {
        parts.push('*All columns are hidden by the column blacklist.*');
      }

      if (blacklisted.size > 0) {
        parts.push('');
        parts.push(`**${blacklisted.size} column(s) hidden:** ${[...blacklisted].join(', ')}`);
      }

      if (fks.length > 0) {
        parts.push('');
        parts.push('### Foreign Keys');
        parts.push('');
        parts.push('| Column | References |');
        parts.push('|--------|-----------|');
        for (const fk of fks) {
          parts.push(`| ${fk.from} | ${fk.table}.${fk.to} |`);
        }
      }

      return jsonResult({ description: parts.join('\n') });
    },
  };
}

// ============ MCP Server Factory ============

/**
 * Create the db-query MCP server with a dedicated read-only connection.
 *
 * The server owns a single SQLite connection that is closed when the
 * returned close() method is called. This is typically called during
 * session teardown.
 *
 * // TODO: Add query timeout — AbortController-based cancellation or a
 * // worker thread with sqlite3_interrupt() could handle pathological queries.
 * // For now, PRAGMA busy_timeout = 5000 handles lock contention only.
 *
 * // TODO: Wire into agent sessions — createDbQueryMcpServer is not yet integrated
 * // into query-options-builder.ts or agent-session.ts. This is intentional
 * // (follow-up task) but should be connected before the db-query server is usable.
 */
export function createDbQueryMcpServer(config: DbQueryToolsConfig): DbQueryMcpServer {
  // Create a dedicated read-only connection
  const db = new Database(config.dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA query_only = ON');

  const handlers = createDbQueryToolHandlers(config, db);

  const scopeDescription =
    config.scopeType === 'global'
      ? 'global scope (full read access to all visible tables, no row filtering)'
      : `${config.scopeType} scope (auto-filters to ${config.scopeType}_id = current entity)`;

  const tools = [
    tool(
      'db_query',
      `Execute a scoped SELECT query against the HyperNeo database. ` +
        `Operating in ${scopeDescription}. ` +
        `Only SELECT statements are allowed — INSERT/UPDATE/DELETE are rejected. ` +
        `Results are limited to ${MAX_LIMIT} rows (default ${DEFAULT_LIMIT}). ` +
        `Sensitive columns are automatically removed from results. ` +
        `Use db_list_tables to see available tables and db_describe_table for column details.`,
      {
        sql: z.string().describe('SELECT SQL statement to execute'),
        params: z
          .array(z.unknown())
          .optional()
          .describe('Parameterized query parameters (positional ? placeholders)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`Maximum rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
      },
      (args) => handlers.db_query(args)
    ),
    tool(
      'db_list_tables',
      `List all tables visible in the current ${config.scopeType} scope with descriptions. ` +
        `Use this to discover what data you can query with db_query.`,
      {},
      () => handlers.db_list_tables()
    ),
    tool(
      'db_describe_table',
      `Show column definitions, types, and foreign keys for a specific table. ` +
        `Sensitive columns are excluded from the output.`,
      {
        table_name: z.string().describe('Name of the table to describe'),
      },
      (args) => handlers.db_describe_table(args)
    ),
  ];

  const server = createSdkMcpServer({ name: 'db-query', version: '1.0.0', tools });

  return {
    ...server,
    tools,
    close() {
      db.close();
    },
  };
}

export type { DbQueryMcpServer };
