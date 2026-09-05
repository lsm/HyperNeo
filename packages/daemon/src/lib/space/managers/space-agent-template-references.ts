import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';

export function countWorkflowSlotsReferencingTemplate(db: BunDatabase, key: string): number {
  const rows = db.prepare(`SELECT config FROM space_workflow_nodes`).all() as Array<{
    config: string | null;
  }>;
  let count = 0;
  for (const row of rows) {
    count += countSlotsReferencingTemplate(row.config, key);
  }

  if (
    tableExists(db, 'space_workflow_definition_versions') &&
    tableExists(db, 'space_workflow_runs') &&
    tableExists(db, 'space_tasks')
  ) {
    const pinnedRows = db
      .prepare(
        `SELECT DISTINCT v.payload
           FROM space_workflow_runs r
           JOIN space_workflow_definition_versions v
             ON v.workflow_id = r.workflow_id AND v.version_hash = r.definition_version
          WHERE r.definition_version IS NOT NULL
            AND (
              NOT EXISTS (SELECT 1 FROM space_tasks t WHERE t.workflow_run_id = r.id)
              OR EXISTS (
                SELECT 1 FROM space_tasks t
                 WHERE t.workflow_run_id = r.id AND t.archived_at IS NULL
              )
            )`
      )
      .all() as Array<{ payload: string | null }>;
    for (const row of pinnedRows) {
      count += countSlotsReferencingTemplateInWorkflow(row.payload, key);
    }
  }
  return count;
}

function countSlotsReferencingTemplate(rawConfig: string | null, key: string): number {
  let slots: unknown = null;
  try {
    slots = rawConfig ? (JSON.parse(rawConfig) as { agents?: unknown }).agents : null;
  } catch {
    return 0;
  }
  if (!Array.isArray(slots)) return 0;
  let count = 0;
  for (const slot of slots) {
    const templateKey =
      slot && typeof slot === 'object'
        ? (slot as { templateKey?: unknown }).templateKey
        : undefined;
    if (typeof templateKey === 'string' && templateKey.trim() === key) count += 1;
  }
  return count;
}

function countSlotsReferencingTemplateInWorkflow(rawPayload: string | null, key: string): number {
  let nodes: unknown = null;
  try {
    nodes = rawPayload ? (JSON.parse(rawPayload) as { nodes?: unknown }).nodes : null;
  } catch {
    return 0;
  }
  if (!Array.isArray(nodes)) return 0;
  let count = 0;
  for (const node of nodes) {
    const agents = node && typeof node === 'object' ? (node as { agents?: unknown }).agents : null;
    if (!Array.isArray(agents)) continue;
    for (const slot of agents) {
      const templateKey =
        slot && typeof slot === 'object'
          ? (slot as { templateKey?: unknown }).templateKey
          : undefined;
      if (typeof templateKey === 'string' && templateKey.trim() === key) count += 1;
    }
  }
  return count;
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
}
