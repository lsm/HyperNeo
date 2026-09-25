import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { relocateBuiltInKeyTemplates } from './m271-relocate-built-in-key-templates.ts';

function rewriteWorkflowSlots(db: BunDatabase, spaceId: string, from: string, to: string): void {
  const rows = db
    .prepare(
      `SELECT n.id, n.config FROM space_workflow_nodes n
       JOIN space_workflows w ON w.id = n.workflow_id
       WHERE w.space_id = ?`
    )
    .all(spaceId) as Array<{ id: string; config: string | null }>;
  const update = db.prepare(
    `UPDATE space_workflow_nodes SET config = ?, updated_at = ? WHERE id = ?`
  );
  for (const row of rows) {
    if (!row.config) continue;
    let config: unknown;
    try {
      config = JSON.parse(row.config);
    } catch {
      continue;
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
    const agents = (config as Record<string, unknown>).agents;
    if (!Array.isArray(agents)) continue;
    let changed = false;
    for (const agent of agents) {
      if (!agent || typeof agent !== 'object' || Array.isArray(agent)) continue;
      const slot = agent as Record<string, unknown>;
      if (slot.templateKey !== from) continue;
      slot.templateKey = to;
      changed = true;
    }
    if (changed) update.run(JSON.stringify(config), Date.now(), row.id);
  }
}

export function runMigration276(db: BunDatabase): void {
  relocateBuiltInKeyTemplates(db, ['space-manager.default'], (spaceId, from, to) => {
    rewriteWorkflowSlots(db, spaceId, from, to);
    db.prepare(
      `UPDATE space_long_horizon_agents SET template_key = ?, updated_at = ?
       WHERE space_id = ? AND template_key = ?`
    ).run(to, Date.now(), spaceId, from);
  });
}
