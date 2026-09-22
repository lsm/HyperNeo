import { createHash } from 'node:crypto';
import { getPresetAgentTemplates } from '../../lib/agents/seed-agents.ts';
import { MIGRATED_AGENT_TEMPLATE_KEY_PREFIX } from '../../lib/agents/template-synthesis.ts';
import { Logger } from '../../lib/logger.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

const log = new Logger('migration-267');

export const PRE_TASK_APPROVE_CONTRACT_SHA256: Record<string, readonly string[]> = {
  Reviewer: [
    '5a5522aa2b9bef20750d8abda7ee86ba9c7d5e322589113dc7418c2570dbad4b',
    '64435f09c601a45f250b7f97b98469fd4eec272604de3634160ce53639d2d85e',
  ],
  QA: ['bf7cd7b5b14b14ae54f08640bf714c07b7749da0990a3392c2d0018457254614'],
};

interface ContractRow {
  id: string;
  instructions: string | null;
}

interface TemplateRow {
  key: string;
  instructions: string | null;
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function runMigration267(db: BunDatabase): void {
  const presets = getPresetAgentTemplates();
  let updated = 0;

  for (const [presetName, staleHashes] of Object.entries(PRE_TASK_APPROVE_CONTRACT_SHA256)) {
    const stale = new Set(staleHashes);
    const preset = presets.find((candidate) => candidate.name === presetName);
    if (!preset) continue;

    if (tableExists(db, 'space_long_horizon_agents')) {
      const rows = db
        .prepare(
          `SELECT id, instructions FROM space_long_horizon_agents
           WHERE handle = ? OR display_name = ? OR template_key = ?`
        )
        .all(preset.handle, presetName, presetName) as ContractRow[];
      const update = db.prepare(
        `UPDATE space_long_horizon_agents SET instructions = ? WHERE id = ?`
      );
      for (const row of rows) {
        if (!row.instructions || !stale.has(sha256(row.instructions))) continue;
        update.run(preset.customPrompt, row.id);
        updated++;
      }
    }

    if (tableExists(db, 'space_agent_templates')) {
      const rows = db
        .prepare(`SELECT key, instructions FROM space_agent_templates WHERE key LIKE ?`)
        .all(`${MIGRATED_AGENT_TEMPLATE_KEY_PREFIX}.%`) as TemplateRow[];
      const update = db.prepare(`UPDATE space_agent_templates SET instructions = ? WHERE key = ?`);
      for (const row of rows) {
        if (!row.instructions || !stale.has(sha256(row.instructions))) continue;
        update.run(preset.customPrompt, row.key);
        updated++;
      }
    }
  }

  if (updated > 0) {
    log.info(
      `[backfill] Re-stamped ${updated} agent contract(s) naming task.resolvePendingCompletion.`
    );
  }
}
