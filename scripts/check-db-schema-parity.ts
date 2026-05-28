import { Database } from 'bun:sqlite';
import {
  getAccessibleTableNames,
  getExcludedTableNames,
} from '../packages/daemon/src/lib/db-query/scope-config';
import { createTables, runMigrations } from '../packages/daemon/src/storage/schema';
import { createSpaceTables } from '../packages/daemon/tests/unit/helpers/space-test-db';

type ColumnRow = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

type ForeignKeyRow = {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
};

type SchemaRow = {
  name: string;
  sql: string | null;
};

type IndexListRow = {
  name: string;
  unique: number;
  origin: string;
  partial: number;
};

type IndexInfoRow = {
  seqno: number;
  name: string;
};

export const HELPER_SCHEMA_TABLES = [
  'channel_cycles',
  'evolution_episodes',
  'evolution_evidence',
  'evolution_lessons',
  'evolution_metric_snapshots',
  'evolution_scopes',
  'evolution_task_proposals',
  'gate_data',
  'goal_automation_cursors',
  'mcp_audit_log',
  'node_executions',
  'pending_agent_messages',
  'sdk_messages',
  'sessions',
  'space_agent_event_subscriptions',
  'space_agent_forge_scope_assignments',
  'space_agent_goal_assignments',
  'space_agent_core_memory',
  'space_agent_inbox_messages',
  'memory_vectors',
  'space_agent_memory',
  'space_agent_memory_fts',
  'space_agent_memory_fts_config',
  'space_agent_memory_fts_data',
  'space_agent_memory_fts_docsize',
  'space_agent_memory_fts_idx',
  'space_agent_reminders',
  'space_agents',
  'space_external_event_deliveries',
  'space_external_event_source_configs',
  'space_external_events',
  'space_goal_events',
  'space_goals',
  'space_long_horizon_agent_event_subscriptions',
  'space_long_horizon_agent_forge_scopes',
  'space_long_horizon_agent_goals',
  'space_long_horizon_agent_reminders',
  'space_long_horizon_agents',
  'space_tasks',
  'space_workflow_nodes',
  'space_workflow_runs',
  'space_workflows',
  'space_worktrees',
  'spaces',
  'task_schedules',
  'workflow_run_artifact_cache',
  'workflow_run_artifacts',
];

function createProductionDb(): Database {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  return db;
}

function createHelperDb(): Database {
  const db = new Database(':memory:');
  createSpaceTables(db);
  return db;
}

function getTableNames(db: Database): string[] {
  return db
    .query(
      `SELECT name
       FROM sqlite_schema
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .all()
    .map((row) => (row as SchemaRow).name);
}

function getTableSql(db: Database, tableName: string): string {
  const row = db
    .query(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?`)
    .get(tableName) as SchemaRow | null;
  return normalizeSchemaSql(row?.sql ?? '');
}

function getColumnMetadata(db: Database, tableName: string): string[] {
  return db
    .query(`PRAGMA table_info(${JSON.stringify(tableName)})`)
    .all()
    .map((row) => {
      const column = row as ColumnRow;
      return [
        column.name,
        column.type,
        column.notnull,
        normalizeDefaultValue(column.dflt_value),
        column.pk,
      ].join('|');
    })
    .sort();
}

function getForeignKeys(db: Database, tableName: string): string[] {
  return db
    .query(`PRAGMA foreign_key_list(${JSON.stringify(tableName)})`)
    .all()
    .map((row) => {
      const fk = row as ForeignKeyRow;
      return [fk.id, fk.seq, fk.table, fk.from, fk.to, fk.on_update, fk.on_delete, fk.match].join(
        '|'
      );
    })
    .sort();
}

function getCheckConstraints(db: Database, tableName: string): string[] {
  const sql = getTableSql(db, tableName);
  const checks: string[] = [];
  let cursor = 0;
  while (cursor < sql.length) {
    const start = sql.indexOf('CHECK(', cursor);
    if (start === -1) break;

    let depth = 0;
    let end = start + 'CHECK'.length;
    for (; end < sql.length; end += 1) {
      const char = sql[end];
      if (char === '(') {
        depth += 1;
      }
      if (char === ')') {
        depth -= 1;
      }
      if (depth === 0 && end > start) {
        end += 1;
        break;
      }
    }

    checks.push(sql.slice(start, end));
    cursor = end + 1;
  }
  return checks.sort();
}

function getIndexes(db: Database, tableName: string): string[] {
  return db
    .query(`PRAGMA index_list(${JSON.stringify(tableName)})`)
    .all()
    .map((row) => {
      const index = row as IndexListRow;
      return [
        index.unique,
        index.origin,
        index.partial,
        getIndexColumns(db, index.name).join(','),
        getIndexSql(db, index.name),
      ].join('|');
    })
    .sort();
}

function getIndexColumns(db: Database, indexName: string): string[] {
  return db
    .query(`PRAGMA index_info(${JSON.stringify(indexName)})`)
    .all()
    .map((row) => {
      const column = row as IndexInfoRow;
      return `${column.seqno}:${column.name}`;
    })
    .sort();
}

function getIndexSql(db: Database, indexName: string): string {
  const row = db
    .query(`SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?`)
    .get(indexName) as SchemaRow | null;
  return normalizeIndexSql(row?.sql ?? '');
}

function normalizeDefaultValue(value: string | null): string {
  const normalized = normalizeSchemaSql(value ?? '');
  return normalized === 'NULL' ? '' : normalized;
}

function normalizeSchemaSql(sql: string): string {
  return sql
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim();
}

function normalizeIndexSql(sql: string): string {
  return normalizeSchemaSql(sql).replace(
    /^CREATE( UNIQUE)? INDEX [^ ]+ ON /,
    'CREATE$1 INDEX <name> ON '
  );
}

function formatList(items: string[]): string {
  return items.map((item) => `  - ${item}`).join('\n');
}

function diffLists(expected: string[], actual: string[]): { missing: string[]; extra: string[] } {
  return {
    missing: expected.filter((item) => !actual.includes(item)),
    extra: actual.filter((item) => !expected.includes(item)),
  };
}

function formatDiff(kind: string, missing: string[], extra: string[]): string[] {
  return [
    ...(missing.length > 0
      ? [`  Missing ${kind}:`, ...missing.map((item) => `    - ${item}`)]
      : []),
    ...(extra.length > 0 ? [`  Extra ${kind}:`, ...extra.map((item) => `    - ${item}`)] : []),
  ];
}

export function checkScopeRegistration(prodDb: Database): string[] {
  const registeredTables = new Set([
    ...getExcludedTableNames(),
    ...getAccessibleTableNames('global'),
    ...getAccessibleTableNames('room'),
    ...getAccessibleTableNames('space'),
  ]);

  const unregisteredTables = getTableNames(prodDb).filter(
    (tableName) => !registeredTables.has(tableName)
  );
  if (unregisteredTables.length === 0) return [];

  return [
    'DB tables missing scope registration. Add each table to EXCLUDED_TABLE_NAMES or a scope config:',
    formatList(unregisteredTables),
  ];
}

export function checkHelperSchemaParity(prodDb: Database, helperDb: Database): string[] {
  const prodTables = new Set(getTableNames(prodDb));
  const helperTables = new Set(getTableNames(helperDb));
  const failures: string[] = [];

  const missingTables = HELPER_SCHEMA_TABLES.filter((tableName) => !helperTables.has(tableName));
  if (missingTables.length > 0) {
    failures.push('space-test-db helper missing expected tables:', formatList(missingTables));
  }

  const extraTables = getTableNames(helperDb).filter(
    (tableName) => !HELPER_SCHEMA_TABLES.includes(tableName)
  );
  if (extraTables.length > 0) {
    failures.push(
      'space-test-db helper has tables not tracked by HELPER_SCHEMA_TABLES:',
      formatList(extraTables)
    );
  }

  for (const tableName of HELPER_SCHEMA_TABLES) {
    if (!prodTables.has(tableName) || !helperTables.has(tableName)) continue;

    const columnDiff = diffLists(
      getColumnMetadata(prodDb, tableName),
      getColumnMetadata(helperDb, tableName)
    );
    if (columnDiff.missing.length > 0 || columnDiff.extra.length > 0) {
      failures.push(
        `space-test-db helper column metadata mismatch for ${tableName}:`,
        ...formatDiff('columns', columnDiff.missing, columnDiff.extra)
      );
    }

    const checkDiff = diffLists(
      getCheckConstraints(prodDb, tableName),
      getCheckConstraints(helperDb, tableName)
    );
    if (checkDiff.missing.length > 0 || checkDiff.extra.length > 0) {
      failures.push(
        `space-test-db helper CHECK constraint mismatch for ${tableName}:`,
        ...formatDiff('CHECK constraints', checkDiff.missing, checkDiff.extra)
      );
    }

    const foreignKeyDiff = diffLists(
      getForeignKeys(prodDb, tableName),
      getForeignKeys(helperDb, tableName)
    );
    if (foreignKeyDiff.missing.length > 0 || foreignKeyDiff.extra.length > 0) {
      failures.push(
        `space-test-db helper foreign key mismatch for ${tableName}:`,
        ...formatDiff('foreign keys', foreignKeyDiff.missing, foreignKeyDiff.extra)
      );
    }

    const indexDiff = diffLists(getIndexes(prodDb, tableName), getIndexes(helperDb, tableName));
    if (indexDiff.missing.length > 0 || indexDiff.extra.length > 0) {
      failures.push(
        `space-test-db helper index mismatch for ${tableName}:`,
        ...formatDiff('indexes', indexDiff.missing, indexDiff.extra)
      );
    }
  }

  return failures;
}

function main(): void {
  const prodDb = createProductionDb();
  const helperDb = createHelperDb();
  const failures = [
    ...checkScopeRegistration(prodDb),
    ...checkHelperSchemaParity(prodDb, helperDb),
  ];
  prodDb.close();
  helperDb.close();

  if (failures.length > 0) {
    console.error(['DB schema parity check failed:', ...failures].join('\n'));
    process.exit(1);
  }

  console.log('DB schema parity check passed.');
}

if (import.meta.main) {
  main();
}
