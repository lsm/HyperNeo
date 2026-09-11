import {
  planTemplateSpaceAssignments,
  type TemplateAttributionInputs,
} from '../../lib/space/agents/template-space-attribution.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

const UNOWNED = '';

export function runMigration244(db: BunDatabase): void {
  if (!tableExists(db, 'space_agent_templates')) return;
  if (!tableHasColumn(db, 'space_agent_templates', 'space_id')) return;

  const templates = db
    .prepare(`SELECT key, created_at FROM space_agent_templates WHERE space_id = ?`)
    .all(UNOWNED) as Array<{ key: string; created_at: number }>;
  if (templates.length === 0) return;

  const plan = planTemplateSpaceAssignments({
    templates: templates.map((row) => ({ key: row.key, createdAt: row.created_at })),
    agents: readAgents(db),
    workflowSlots: readWorkflowSlots(db),
    spaceIds: readSpaceIds(db),
  });

  const claim = db.prepare(
    `UPDATE space_agent_templates SET space_id = ? WHERE space_id = ? AND key = ?`
  );
  const carried = `key, handle, display_name, description, instructions,
       suggested_autonomy_level, model, provider, model_pool, thinking_level,
       setting_sources, tools, version, labels, created_at, updated_at`;
  const copy = db.prepare(
    `INSERT INTO space_agent_templates (space_id, ${carried})
       SELECT ?, ${carried} FROM space_agent_templates WHERE space_id = ? AND key = ?`
  );
  const remove = db.prepare(`DELETE FROM space_agent_templates WHERE space_id = ? AND key = ?`);

  db.exec('BEGIN');
  try {
    for (const assignment of plan.assignments) {
      const [owner, ...copies] = assignment.spaceIds;
      for (const spaceId of copies) copy.run(spaceId, UNOWNED, assignment.key);
      claim.run(owner, UNOWNED, assignment.key);
    }
    for (const key of plan.deletions) remove.run(UNOWNED, key);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function readAgents(db: BunDatabase): TemplateAttributionInputs['agents'] {
  if (!tableExists(db, 'space_long_horizon_agents')) return [];
  const rows = db
    .prepare(`SELECT id, space_id, created_at FROM space_long_horizon_agents`)
    .all() as Array<{ id: string; space_id: string; created_at: number }>;
  return rows.map((row) => ({ id: row.id, spaceId: row.space_id, createdAt: row.created_at }));
}

function readSpaceIds(db: BunDatabase): string[] {
  if (!tableExists(db, 'spaces')) return [];
  const rows = db.prepare(`SELECT id FROM spaces`).all() as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function readWorkflowSlots(db: BunDatabase): TemplateAttributionInputs['workflowSlots'] {
  if (!tableExists(db, 'space_workflow_nodes')) return [];
  if (!tableExists(db, 'space_workflows')) return [];
  const rows = db
    .prepare(
      `SELECT w.space_id AS space_id, n.config AS config
         FROM space_workflow_nodes n
         JOIN space_workflows w ON w.id = n.workflow_id`
    )
    .all() as Array<{ space_id: string; config: string | null }>;

  const slots: Array<{ spaceId: string; templateKey: string | null }> = [];
  for (const row of rows) {
    for (const templateKey of slotTemplateKeys(row.config)) {
      slots.push({ spaceId: row.space_id, templateKey });
    }
  }
  return slots;
}

function slotTemplateKeys(config: string | null): string[] {
  if (typeof config !== 'string' || config === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(config);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') return [];
  const agents = (parsed as Record<string, unknown>).agents;
  if (!Array.isArray(agents)) return [];
  const keys: string[] = [];
  for (const raw of agents) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const templateKey = (raw as Record<string, unknown>).templateKey;
    if (typeof templateKey === 'string' && templateKey.trim() !== '') keys.push(templateKey.trim());
  }
  return keys;
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
}

function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`).all() as Array<{
    name: string;
  }>;
  return rows.some((row) => row.name === columnName);
}
