import type {
  DaemonInventoryEntry,
  DaemonInventoryPage,
} from '@hyperneo/shared/types/daemon-snapshot';
import type { Database } from '../sqlite-compat.ts';

const SOURCES = [
  {
    kind: 'session',
    query: `SELECT id, title AS name, status, last_active_at AS updatedAt,
      COALESCE(main_repo_path, workspace_path) AS workspacePath,
      space_id AS spaceId, parent_id AS parentSessionId FROM sessions`,
    visible: "status != 'archived'",
  },
  {
    kind: 'space',
    query: `SELECT id, name, CASE WHEN status = 'archived' THEN status
      WHEN stopped = 1 THEN 'stopped' WHEN paused = 1 THEN 'paused' ELSE status END AS status,
      updated_at AS updatedAt, workspace_path AS workspacePath FROM spaces`,
    visible: "status != 'archived'",
  },
  {
    kind: 'task',
    query: `SELECT id, title AS name, status, updated_at AS updatedAt,
      workspace_path AS workspacePath, space_id AS spaceId, archived_at AS archivedAt,
      workflow_run_id AS workflowRunId, task_agent_session_id AS sessionId,
      goal_id AS goalId, evolution_scope_id AS evolutionScopeId FROM space_tasks`,
    visible: "archivedAt IS NULL AND status != 'archived'",
  },
  {
    kind: 'agent',
    query: `SELECT id, display_name AS name, status, updated_at AS updatedAt,
      space_id AS spaceId, session_id AS sessionId FROM space_long_horizon_agents`,
    visible: "status != 'archived'",
  },
  {
    kind: 'workflow',
    query: `SELECT id, name, CASE WHEN disabled = 1 THEN 'disabled' ELSE 'enabled' END AS status,
      updated_at AS updatedAt, space_id AS spaceId FROM space_workflows`,
    visible: '1 = 1',
  },
  {
    kind: 'workflow_run',
    query: `SELECT id, title AS name, status, updated_at AS updatedAt,
      space_id AS spaceId, workflow_id AS workflowId FROM space_workflow_runs`,
    visible: '1 = 1',
  },
  {
    kind: 'goal',
    query: `SELECT id, title AS name, status, updated_at AS updatedAt,
      workspace_path AS workspacePath, space_id AS spaceId FROM space_goals`,
    visible: "status != 'archived'",
  },
  {
    kind: 'evolution_scope',
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

export class DaemonInventoryRepository {
  constructor(private readonly db: Database) {}

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
      SOURCES.map(({ kind, query, visible }) => {
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
