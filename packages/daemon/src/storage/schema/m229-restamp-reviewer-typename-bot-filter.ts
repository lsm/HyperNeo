import { createHash } from 'node:crypto';
import { Logger } from '../../lib/logger.ts';
import { getPresetAgentTemplates } from '../../lib/space/agents/seed-agents.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

const log = new Logger('migration-229');

export const STALE_PRE_TYPENAME_REVIEWER_CONTRACT_SHA256 =
  '889cd3f14d9f5b161e7e972ec9348337c4e02cae8a3ed8e4cdb999b3aeb381b8';

export const STALE_PRE_TYPENAME_REVIEWER_DESCRIPTION =
  'Code review specialist. Reviews pull requests for correctness, style, and test coverage. Bash is permission-scoped to read-only gh PR inspection and review posting.';

export const STALE_PRE_TYPENAME_REVIEWER_TOOLS: readonly string[] = [
  'Read',
  'Bash(gh pr view:*)',
  'Bash(gh pr diff:*)',
  'Bash(gh pr checks:*)',
  'Bash(gh api graphql:*)',
  'Bash(gh api repos:*)',
  'Bash(jq:*)',
  'Bash(mktemp:*)',
  'Bash(echo:*)',
  'Bash(cat:*)',
  'Bash(test:*)',
  'Bash(head:*)',
  'Bash(tr:*)',
  'Bash(base64:*)',
  'Bash(exit:*)',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'Skill',
  'ToolSearch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'CronCreate',
  'CronDelete',
  'CronList',
];

interface ReviewerRow {
  id: string;
  template_key: string | null;
  instructions: string | null;
  description: string | null;
  tool_permissions_json: string | null;
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
  return !!result;
}

export function isPristineReviewerRow(row: ReviewerRow): boolean {
  let storedTools: string[] = [];
  try {
    const parsed = row.tool_permissions_json
      ? (JSON.parse(row.tool_permissions_json) as { tools?: unknown })
      : {};
    storedTools = Array.isArray(parsed.tools) ? parsed.tools.map((t) => String(t)) : [];
  } catch {
    return false;
  }
  const descriptionPristine =
    row.template_key === 'Reviewer'
      ? row.description === null || row.description === STALE_PRE_TYPENAME_REVIEWER_DESCRIPTION
      : row.description === STALE_PRE_TYPENAME_REVIEWER_DESCRIPTION;
  return (
    descriptionPristine &&
    [...storedTools].sort().join('\u0000') ===
      [...STALE_PRE_TYPENAME_REVIEWER_TOOLS].sort().join('\u0000')
  );
}

export function runMigration229(db: BunDatabase): void {
  if (!tableExists(db, 'space_long_horizon_agents')) return;

  const presets = getPresetAgentTemplates();
  const reviewer = presets.find((preset) => preset.name === 'Reviewer');
  if (!reviewer) return;

  const rows = db
    .prepare(
      `SELECT id, template_key, instructions, description, tool_permissions_json
       FROM space_long_horizon_agents
       WHERE handle = 'reviewer' OR display_name = 'Reviewer' OR template_key = 'Reviewer'`
    )
    .all() as ReviewerRow[];

  const update = db.prepare(`UPDATE space_long_horizon_agents SET instructions = ? WHERE id = ?`);
  let updated = 0;

  for (const row of rows) {
    if (!row.instructions) continue;
    const sha = createHash('sha256').update(row.instructions).digest('hex');
    if (sha !== STALE_PRE_TYPENAME_REVIEWER_CONTRACT_SHA256) continue;
    if (!isPristineReviewerRow(row)) continue;

    update.run(reviewer.customPrompt, row.id);
    updated++;
  }

  if (updated > 0) {
    log.info(
      `[backfill] Re-stamped Reviewer preset row(s) with the __typename bot-filter contract.`
    );
  }
}
