import { createHash } from 'node:crypto';
import { Logger } from '../../lib/logger.ts';
import { MIGRATED_AGENT_TEMPLATE_KEY_PREFIX } from '../../lib/space/agents/agent-template-synthesis.ts';
import { getPresetAgentTemplates } from '../../lib/space/agents/seed-agents.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import {
  hasStockReviewerTools,
  isPristineReviewerRow,
  STALE_PRE_TYPENAME_REVIEWER_CONTRACT_SHA256,
} from './m229-restamp-reviewer-typename-bot-filter.ts';

const log = new Logger('migration-230');

export const PRE_CHECK_SEEDING_REVIEWER_CONTRACT_SHA256 =
  '9693ef07bdb425e70b63f095c20b19e687ff27a3b0efe7904d76cfb79972456e';

interface ReviewerAgentRow {
  id: string;
  template_key: string | null;
  instructions: string | null;
  description: string | null;
  tool_permissions_json: string | null;
}

interface SynthesizedTemplateRow {
  key: string;
  instructions: string | null;
}

interface ClearedDescriptionRow {
  id: string;
  instructions: string | null;
  tool_permissions_json: string | null;
  updated_at: number;
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
  return !!result;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function migratedTemplateSourceAgentId(key: string): string {
  return key.slice(MIGRATED_AGENT_TEMPLATE_KEY_PREFIX.length + 1).replace(/\.m228(-\d+)?$/, '');
}

function migration229AppliedAt(db: BunDatabase): number | null {
  if (!tableExists(db, 'migration_markers')) return null;
  const row = db
    .prepare(`SELECT applied_at FROM migration_markers WHERE key = 'migration_229'`)
    .get() as { applied_at: number } | undefined;
  return row?.applied_at ?? null;
}

export function runMigration230(db: BunDatabase): void {
  const presets = getPresetAgentTemplates();
  const reviewer = presets.find((preset) => preset.name === 'Reviewer');
  if (!reviewer) return;

  const hasAgentsTable = tableExists(db, 'space_long_horizon_agents');
  const reviewerRows = hasAgentsTable
    ? (db
        .prepare(
          `SELECT id, template_key, instructions, description, tool_permissions_json
           FROM space_long_horizon_agents
           WHERE handle = 'reviewer' OR display_name = 'Reviewer' OR template_key = 'Reviewer'`
        )
        .all() as ReviewerAgentRow[])
    : [];
  const pristineSourceIds = new Set(
    reviewerRows.filter((row) => isPristineReviewerRow(row)).map((row) => row.id)
  );

  let updated = 0;

  if (hasAgentsTable) {
    const update = db.prepare(`UPDATE space_long_horizon_agents SET instructions = ? WHERE id = ?`);
    for (const row of reviewerRows) {
      if (
        typeof row.instructions === 'string' &&
        row.instructions.length > 0 &&
        sha256(row.instructions) === PRE_CHECK_SEEDING_REVIEWER_CONTRACT_SHA256 &&
        pristineSourceIds.has(row.id)
      ) {
        update.run(reviewer.customPrompt, row.id);
        updated++;
      }
    }

    const m229AppliedAt = migration229AppliedAt(db);
    if (m229AppliedAt !== null) {
      const clearedRows = db
        .prepare(
          `SELECT id, instructions, tool_permissions_json, updated_at
           FROM space_long_horizon_agents
           WHERE (handle = 'reviewer' OR display_name = 'Reviewer' OR template_key = 'Reviewer')
             AND description IS NULL AND template_key IS NOT 'Reviewer'`
        )
        .all() as ClearedDescriptionRow[];
      for (const row of clearedRows) {
        if (
          typeof row.instructions === 'string' &&
          row.instructions.length > 0 &&
          sha256(row.instructions) === PRE_CHECK_SEEDING_REVIEWER_CONTRACT_SHA256 &&
          hasStockReviewerTools(row.tool_permissions_json) &&
          row.updated_at < m229AppliedAt
        ) {
          update.run(reviewer.customPrompt, row.id);
          updated++;
        }
      }
    }
  }

  if (tableExists(db, 'space_agent_templates')) {
    const templates = db
      .prepare(`SELECT key, instructions FROM space_agent_templates WHERE key LIKE ?`)
      .all(`${MIGRATED_AGENT_TEMPLATE_KEY_PREFIX}.%`) as SynthesizedTemplateRow[];
    const updateTemplate = db.prepare(
      `UPDATE space_agent_templates SET instructions = ? WHERE key = ?`
    );
    for (const row of templates) {
      if (!row.instructions) continue;
      if (sha256(row.instructions) !== STALE_PRE_TYPENAME_REVIEWER_CONTRACT_SHA256) continue;
      if (!pristineSourceIds.has(migratedTemplateSourceAgentId(row.key))) continue;
      updateTemplate.run(reviewer.customPrompt, row.key);
      updated++;
    }
  }

  if (updated > 0) {
    log.info(
      `[backfill] Re-stamped Reviewer agent rows and synthesized templates with the check-seeding contract.`
    );
  }
}
