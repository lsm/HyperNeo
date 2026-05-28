import { Database } from 'bun:sqlite';
import {
  getAccessibleTableNames,
  getExcludedTableNames,
} from '../packages/daemon/src/lib/db-query/scope-config';
import { createTables, runMigrations } from '../packages/daemon/src/storage/schema';
import { createSpaceTables } from '../packages/daemon/tests/unit/helpers/space-test-db';

type ColumnRow = {
  name: string;
};

type TableRow = {
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
  'space_agent_inbox_messages',
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
  'spaces',
  'task_schedules',
  'workflow_run_artifact_cache',
  'workflow_run_artifacts',
];

const HELPER_SCHEMA_COLUMN_OVERRIDES: Record<string, string[]> = {
  sessions: ['id', 'type', 'session_context'],
};

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
    .map((row) => (row as TableRow).name);
}

function getColumnNames(db: Database, tableName: string): string[] {
  return db
    .query(`PRAGMA table_info(${JSON.stringify(tableName)})`)
    .all()
    .map((row) => (row as ColumnRow).name);
}

function formatList(items: string[]): string {
  return items.map((item) => `  - ${item}`).join('\n');
}

function checkScopeRegistration(prodDb: Database): string[] {
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

function checkHelperSchemaParity(prodDb: Database, helperDb: Database): string[] {
  const prodTables = new Set(getTableNames(prodDb));
  const helperTables = new Set(getTableNames(helperDb));
  const failures: string[] = [];

  const missingTables = HELPER_SCHEMA_TABLES.filter((tableName) => !helperTables.has(tableName));
  if (missingTables.length > 0) {
    failures.push('space-test-db helper missing expected tables:', formatList(missingTables));
  }

  const extraTables = getTableNames(helperDb).filter(
    (tableName) => !HELPER_SCHEMA_TABLES.includes(tableName) && prodTables.has(tableName)
  );
  if (extraTables.length > 0) {
    failures.push(
      'space-test-db helper has production tables not tracked by HELPER_SCHEMA_TABLES:',
      formatList(extraTables)
    );
  }

  for (const tableName of HELPER_SCHEMA_TABLES) {
    if (!prodTables.has(tableName) || !helperTables.has(tableName)) continue;

    const prodColumns =
      HELPER_SCHEMA_COLUMN_OVERRIDES[tableName] ?? getColumnNames(prodDb, tableName);
    const helperColumns = getColumnNames(helperDb, tableName);
    const missingColumns = prodColumns.filter((columnName) => !helperColumns.includes(columnName));
    const extraColumns = helperColumns.filter((columnName) => !prodColumns.includes(columnName));

    if (missingColumns.length > 0 || extraColumns.length > 0) {
      failures.push(
        `space-test-db helper schema mismatch for ${tableName}:`,
        ...(missingColumns.length > 0
          ? ['  Missing columns:', ...missingColumns.map((columnName) => `    - ${columnName}`)]
          : []),
        ...(extraColumns.length > 0
          ? ['  Extra columns:', ...extraColumns.map((columnName) => `    - ${columnName}`)]
          : [])
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
