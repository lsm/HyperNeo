import type {
  DaemonInventoryEntry,
  DaemonInventoryPage,
} from '@hyperneo/shared/types/daemon-snapshot';
import type { Database } from '../sqlite-compat.ts';
import { schemaTableExists } from '../schema/extensions.ts';

const SOURCES = [
  {
    kind: 'session',
    table: 'sessions',
    query: `SELECT id, title AS name, status, last_active_at AS updatedAt,
      COALESCE(main_repo_path, json_extract(metadata, '$.executionProjectPath'), workspace_path) AS workspacePath,
      space_id AS spaceId, parent_id AS parentSessionId FROM sessions`,
    visible: "status != 'archived'",
  },
  {
    kind: 'space',
    table: 'spaces',
    query: `SELECT id, name, CASE WHEN status = 'archived' THEN status
      WHEN stopped = 1 THEN 'stopped' WHEN paused = 1 THEN 'paused' ELSE status END AS status,
      updated_at AS updatedAt, workspace_path AS workspacePath FROM spaces`,
    visible: "status != 'archived'",
  },
  {
    kind: 'task',
    table: 'space_tasks',
    query: `SELECT id, title AS name, status, updated_at AS updatedAt,
      workspace_path AS workspacePath, space_id AS spaceId, archived_at AS archivedAt,
      workflow_run_id AS workflowRunId, task_agent_session_id AS sessionId,
      goal_id AS goalId, evolution_scope_id AS evolutionScopeId FROM space_tasks`,
    visible: "archivedAt IS NULL AND status != 'archived'",
  },
  {
    kind: 'agent',
    table: 'space_long_horizon_agents',
    query: `SELECT id, display_name AS name, status, updated_at AS updatedAt,
      space_id AS spaceId, session_id AS sessionId FROM space_long_horizon_agents`,
    visible: "status != 'archived'",
  },
  {
    kind: 'workflow',
    table: 'space_workflows',
    query: `SELECT id, name, CASE WHEN disabled = 1 THEN 'disabled' ELSE 'enabled' END AS status,
      updated_at AS updatedAt, space_id AS spaceId FROM space_workflows`,
    visible: '1 = 1',
  },
  {
    kind: 'workflow_run',
    table: 'space_workflow_runs',
    query: `SELECT id, title AS name, status, updated_at AS updatedAt,
      space_id AS spaceId, workflow_id AS workflowId FROM space_workflow_runs`,
    visible: '1 = 1',
  },
  {
    kind: 'goal',
    table: 'space_goals',
    query: `SELECT id, title AS name, status, updated_at AS updatedAt,
      workspace_path AS workspacePath, space_id AS spaceId FROM space_goals`,
    visible: "status != 'archived'",
  },
  {
    kind: 'evolution_scope',
    table: 'evolution_scopes',
    query: `SELECT id, name, NULL AS status, updated_at AS updatedAt,
      space_id AS spaceId, space_goal_id AS goalId, parent_scope_id AS evolutionScopeId
      FROM evolution_scopes`,
    visible: '1 = 1',
  },
] as const;

type InventoryRow = Omit<DaemonInventoryEntry, 'updatedAt' | 'links' | 'workspacePath'> & {
  updatedAt: string | number;
  workspacePath?: string | null;
} & Partial<
    Record<
      | 'spaceId'
      | 'sessionId'
      | 'parentSessionId'
      | 'workflowId'
      | 'workflowRunId'
      | 'goalId'
      | 'evolutionScopeId',
      string | null
    >
  >;

const LINKS = [
  ['space', 'spaceId'],
  ['session', 'sessionId'],
  ['session', 'parentSessionId'],
  ['workflow', 'workflowId'],
  ['workflow_run', 'workflowRunId'],
  ['goal', 'goalId'],
  ['evolution_scope', 'evolutionScopeId'],
] as const;

export interface SessionInspectionRecord {
  id: string;
  name: string;
  status: string;
  lastActiveAt: string;
  workspacePath: string | null;
  processingStatus: string | null;
  scopeOwned: number;
  neoBound: number;
}

function entryFromRow(row: InventoryRow): DaemonInventoryEntry {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : Date.parse(row.updatedAt),
    workspacePath: row.workspacePath ?? null,
    links: LINKS.flatMap(([kind, key]) => (row[key] ? [{ kind, id: row[key] }] : [])),
  };
}

const SPACE_OWNED_SESSION = `OR EXISTS (SELECT 1 FROM direct_task_session_provenance p WHERE p.session_id = s.id)
        OR EXISTS (SELECT 1 FROM node_executions e WHERE e.agent_session_id = s.id)
        OR EXISTS (SELECT 1 FROM space_long_horizon_agents a
          WHERE a.session_id = s.id OR a.session_id = s.parent_id)`;

export class DaemonInventoryRepository {
  constructor(private readonly db: Database) {}

  readSession(sessionId: string): SessionInspectionRecord | null {
    const spaceOwned = schemaTableExists(this.db, 'spaces') ? SPACE_OWNED_SESSION : '';
    return (
      (this.db
        .prepare(`SELECT s.id, s.title AS name, s.status,
      s.last_active_at AS lastActiveAt, COALESCE(s.main_repo_path, json_extract(s.metadata, '$.executionProjectPath'), s.workspace_path) AS workspacePath,
      CASE WHEN json_valid(s.processing_state) THEN
        CASE WHEN json_type(s.processing_state, '$.status') = 'text'
          THEN json_extract(s.processing_state, '$.status') ELSE NULL END
        ELSE s.processing_state END AS processingStatus,
      (s.space_id IS NOT NULL OR s.task_id IS NOT NULL OR COALESCE(s.type, 'worker') != 'worker'
        OR CASE WHEN s.session_context IS NULL THEN 0 WHEN json_valid(s.session_context) THEN
          json_type(s.session_context) != 'object'
          OR json_type(s.session_context, '$.spaceId') IS NOT NULL
          OR json_type(s.session_context, '$.taskId') IS NOT NULL
          OR json_type(s.session_context, '$.roomId') IS NOT NULL
          OR json_type(s.session_context, '$.lobbyId') IS NOT NULL ELSE 1 END
        ${spaceOwned}) AS scopeOwned,
      EXISTS (SELECT 1 FROM neo_session_bindings b WHERE b.session_id = s.id OR b.session_id = s.parent_id) AS neoBound
      FROM sessions s WHERE s.id = ? LIMIT 1`)
        .get(sessionId) as SessionInspectionRecord | null) ?? null
    );
  }

  read({
    limit,
    includeArchived,
  }: {
    limit: number;
    includeArchived: boolean;
  }): DaemonInventoryPage[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new Error('Invalid inventory limit');
    return this.db.transaction(() =>
      SOURCES.map(({ kind, table, query, visible }) => {
        if (!schemaTableExists(this.db, table)) return { kind, total: 0, entries: [] };
        const from = `FROM (${query}) WHERE ${includeArchived ? '1 = 1' : visible}`;
        const count = this.db.prepare(`SELECT COUNT(*) AS total ${from}`).get() as {
          total: number;
        };
        const rows = this.db
          .prepare(`SELECT * ${from} ORDER BY updatedAt DESC, id ASC LIMIT ?`)
          .all(limit) as InventoryRow[];
        return { kind, total: count.total, entries: rows.map(entryFromRow) };
      })
    )();
  }
}
