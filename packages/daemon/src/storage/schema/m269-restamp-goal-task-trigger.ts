import { createHash } from 'node:crypto';
import { LH_TASK_MANAGER_INSTRUCTIONS } from '@hyperneo/prompts';
import { Logger } from '../../lib/logger.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

const log = new Logger('migration-269');

export const PRE_GOAL_TASK_TRIGGER_TASK_MANAGER_SHA256 =
  'eb745cdb7aa9523e77ac5093da7e252b5de90070b812777b8f2c79ec28de644e';

interface InstructionRow {
  id: string;
  instructions: string | null;
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function runMigration269(db: BunDatabase): void {
  if (!tableExists(db, 'space_long_horizon_agents')) return;
  const rows = db
    .prepare(`SELECT id, instructions FROM space_long_horizon_agents WHERE handle = ?`)
    .all('task-manager') as InstructionRow[];
  const update = db.prepare(`UPDATE space_long_horizon_agents SET instructions = ? WHERE id = ?`);
  let updated = 0;
  for (const row of rows) {
    if (!row.instructions) continue;
    if (sha256(row.instructions) !== PRE_GOAL_TASK_TRIGGER_TASK_MANAGER_SHA256) continue;
    update.run(LH_TASK_MANAGER_INSTRUCTIONS, row.id);
    updated++;
  }
  if (updated > 0) {
    log.info(`[backfill] Re-stamped ${updated} task-manager agent(s) naming goal.triggerTask.`);
  }
}
