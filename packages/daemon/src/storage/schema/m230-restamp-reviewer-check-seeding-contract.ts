import { createHash } from 'node:crypto';
import { Logger } from '../../lib/logger.ts';
import { MIGRATED_AGENT_TEMPLATE_KEY_PREFIX } from '../../lib/space/agents/agent-template-synthesis.ts';
import { getPresetAgentTemplates } from '../../lib/space/agents/seed-agents.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import {
  isPristineReviewerRow,
  STALE_PRE_TYPENAME_REVIEWER_CONTRACT_SHA256,
  STALE_PRE_TYPENAME_REVIEWER_DESCRIPTION,
  STALE_PRE_TYPENAME_REVIEWER_TOOLS,
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
  description: string | null;
  tools: string | null;
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
  return !!result;
}

function isPristineSynthesizedReviewerTemplate(row: SynthesizedTemplateRow): boolean {
  let storedTools: string[] = [];
  try {
    const parsed = row.tools ? (JSON.parse(row.tools) as unknown) : [];
    storedTools = Array.isArray(parsed) ? parsed.map((t) => String(t)) : [];
  } catch {
    return false;
  }
  const descriptionPristine =
    row.description === '' || row.description === STALE_PRE_TYPENAME_REVIEWER_DESCRIPTION;
  return (
    descriptionPristine &&
    [...storedTools].sort().join('\u0000') ===
      [...STALE_PRE_TYPENAME_REVIEWER_TOOLS].sort().join('\u0000')
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function runMigration230(db: BunDatabase): void {
  const presets = getPresetAgentTemplates();
  const reviewer = presets.find((preset) => preset.name === 'Reviewer');
  if (!reviewer) return;

  let updated = 0;

  if (tableExists(db, 'space_long_horizon_agents')) {
    const rows = db
      .prepare(
        `SELECT id, template_key, instructions, description, tool_permissions_json
         FROM space_long_horizon_agents
         WHERE handle = 'reviewer' OR display_name = 'Reviewer' OR template_key = 'Reviewer'`
      )
      .all();
    const update = db.prepare(`UPDATE space_long_horizon_agents SET instructions = ? WHERE id = ?`);
    for (const row of rows as ReviewerAgentRow[]) {
      if (
        typeof row.instructions === 'string' &&
        row.instructions.length > 0 &&
        sha256(row.instructions) === PRE_CHECK_SEEDING_REVIEWER_CONTRACT_SHA256 &&
        isPristineReviewerRow(row)
      ) {
        update.run(reviewer.customPrompt, row.id);
        updated++;
      }
    }
  }

  if (tableExists(db, 'space_agent_templates')) {
    const templates = db
      .prepare(
        `SELECT key, instructions, description, tools FROM space_agent_templates WHERE key LIKE ?`
      )
      .all(`${MIGRATED_AGENT_TEMPLATE_KEY_PREFIX}.%`) as SynthesizedTemplateRow[];
    const updateTemplate = db.prepare(
      `UPDATE space_agent_templates SET instructions = ? WHERE key = ?`
    );
    for (const row of templates) {
      if (
        row.instructions &&
        sha256(row.instructions) === STALE_PRE_TYPENAME_REVIEWER_CONTRACT_SHA256 &&
        isPristineSynthesizedReviewerTemplate(row)
      ) {
        updateTemplate.run(reviewer.customPrompt, row.key);
        updated++;
      }
    }
  }

  if (updated > 0) {
    log.info(
      `[backfill] Re-stamped Reviewer agent rows and synthesized templates with the check-seeding contract.`
    );
  }
}
