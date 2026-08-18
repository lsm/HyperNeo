import { Database } from '../../storage/sqlite-compat';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { type DbScopeType, type ScopeTableConfig, getScopeConfig } from './scope-config.ts';
import { validateSql } from './sql-validator.ts';

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

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

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

function stripOrderBy(sql: string): { sql: string; orderBy?: string } {
  const pos = findTopLevelKeyword(sql, 'ORDER BY');
  if (pos === -1) return { sql };

  const orderBy = sql.slice(pos).trimEnd();
  return { sql: sql.slice(0, pos).trimEnd(), orderBy };
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

function injectWhereClause(sql: string, whereClause: string): string {
  const wherePos = findTopLevelKeyword(sql, 'WHERE');

  if (wherePos !== -1) {
    const boundary = findTopLevelBoundary(sql);
    return `${sql.slice(0, boundary)} AND ${whereClause}${sql.slice(boundary)}`;
  }

  const insertPos = findTopLevelBoundary(sql);

  if (insertPos < sql.length) {
    return `${sql.slice(0, insertPos)} WHERE ${whereClause} ${sql.slice(insertPos)}`;
  }

  return `${sql} WHERE ${whereClause}`;
}

function buildPrefixedScopeFilter(
  config: ScopeTableConfig,
  scopeValue: string
): { whereClause: string; params: unknown[] } {
  if (!config.scopeColumn && !config.scopeJoin && !config.scopeLike) {
    return { whereClause: '', params: [] };
  }

  if (config.scopeColumn) {
    return {
      whereClause: `_dbq.${config.scopeColumn} = ?`,
      params: [scopeValue],
    };
  }

  if (config.scopeLike) {
    const { column, patternPrefix, patternSuffix } = config.scopeLike;
    return {
      whereClause: `_dbq.${column} LIKE ?`,
      params: [`${patternPrefix}${scopeValue}${patternSuffix}`],
    };
  }

  if (config.scopeJoin) {
    const join = config.scopeJoin;
    if (join.likePrefix !== undefined) {
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

function rewriteScopedQuery(
  sql: string,
  userParams: unknown[],
  scopeType: DbScopeType,
  scopeValue: string,
  tableConfigs: Map<string, ScopeTableConfig>,
  userLimit?: number
): { sql: string; params: unknown[]; cappedLimit: number } {
  const cappedLimit = Math.min(userLimit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const scopeFilterSet = new Map<string, unknown[]>();
  for (const config of tableConfigs.values()) {
    const filter = buildPrefixedScopeFilter(config, scopeValue);
    if (filter.whereClause && !scopeFilterSet.has(filter.whereClause)) {
      scopeFilterSet.set(filter.whereClause, filter.params);
    }
  }

  if (scopeFilterSet.size === 0) {
    const { sql: strippedSql, userLimit: existingLimit } = stripLimit(sql);
    const effectiveLimit = Math.min(cappedLimit, existingLimit ?? MAX_LIMIT);
    return {
      sql: `${strippedSql} LIMIT ${effectiveLimit}`,
      params: userParams,
      cappedLimit: effectiveLimit,
    };
  }

  const { sql: strippedSql, userLimit: existingLimit } = stripLimit(sql);
  const effectiveLimit = Math.min(cappedLimit, existingLimit ?? MAX_LIMIT);
  const scopeParams = [...scopeFilterSet.values()].flat();

  if (isAggregateOrDistinctQuery(strippedSql)) {
    const innerRewritten = rewriteSelectToStar(strippedSql, { skipOutermost: true });

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

  const combinedWhere = [...scopeFilterSet.keys()].join(' AND ');

  const { sql: noOrderBy, orderBy } = stripOrderBy(strippedSql);

  const innerSql = rewriteSelectToStar(noOrderBy);

  const orderClause = orderBy ? ` ${orderBy}` : '';
  const wrappedSql = `SELECT * FROM (${innerSql}) AS _dbq WHERE ${combinedWhere}${orderClause} LIMIT ${effectiveLimit}`;

  return { sql: wrappedSql, params: [...userParams, ...scopeParams], cappedLimit: effectiveLimit };
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

function jsonResult(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function createDbQueryToolHandlers(config: DbQueryToolsConfig, db: Database) {
  const { scopeType, scopeValue } = config;
  const scopeConfigs = getScopeConfig(scopeType);

  const configMap = new Map<string, ScopeTableConfig>();
  for (const tc of scopeConfigs) {
    configMap.set(tc.tableName, tc);
  }

  return {
    async db_query(args: { sql: string; params?: unknown[]; limit?: number }): Promise<ToolResult> {
      const { sql, params = [], limit } = args;

      const validation = validateSql(sql);
      if (!validation.valid) {
        return errorResult(validation.error ?? 'Invalid SQL');
      }

      for (const tableRef of validation.tableRefs) {
        if (!configMap.has(tableRef)) {
          return errorResult(`Table "${tableRef}" is not accessible in ${scopeType} scope`);
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

      if (!configMap.has(table_name)) {
        return errorResult(`Table "${table_name}" is not accessible in ${scopeType} scope`);
      }

      const tableConfig = configMap.get(table_name)!;
      const blacklisted = new Set(tableConfig.blacklistedColumns);

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

      const visibleColumns = columns.filter((col) => !blacklisted.has(col.name));

      const fks = db.query(`PRAGMA foreign_key_list("${table_name}")`).all() as Array<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
      }>;

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

export function createDbQueryMcpServer(config: DbQueryToolsConfig): DbQueryMcpServer {
  const db = new Database(config.dbPath, { readonly: true });
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
