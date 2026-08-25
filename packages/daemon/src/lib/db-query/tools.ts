import { Database } from '../../storage/sqlite-compat.ts';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { Logger } from '../logger.ts';
import { DbQueryWorkerService, DbQueryWorkerUnavailableError } from './db-query-worker-service.ts';
import { type DbScopeType, type ScopeTableConfig, getScopeConfig } from './scope-config.ts';
import { DEFAULT_LIMIT, MAX_LIMIT, runScopedQuery } from './scoped-query.ts';

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

const dbQueryLog = new Logger('DbQuery');

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
      try {
        return jsonResult(runScopedQuery(db, scopeType, scopeValue, args));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
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
  db.exec('PRAGMA case_sensitive_like = ON');

  const handlers = createDbQueryToolHandlers(config, db);
  const workerService = new DbQueryWorkerService(config.dbPath);
  let warnedWorkerUnavailable = false;

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
        `Queries run on a background worker and are terminated after a timeout. ` +
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
      (args) =>
        workerService
          .query({
            scopeType: config.scopeType,
            scopeValue: config.scopeValue,
            sql: args.sql,
            params: args.params,
            limit: args.limit,
          })
          .then(
            (result) => jsonResult(result),
            (err: unknown) => {
              if (err instanceof DbQueryWorkerUnavailableError && !warnedWorkerUnavailable) {
                warnedWorkerUnavailable = true;
                dbQueryLog.warn(err.message);
              }
              return errorResult(err instanceof Error ? err.message : String(err));
            }
          )
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
      workerService.close();
      db.close();
    },
  };
}

export type { DbQueryMcpServer };
