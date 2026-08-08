/**
 * Migration 179 — Backfill Bash + Cron tools onto existing Reviewer preset rows.
 *
 * Context: the Reviewer preset gained `Bash` + `CronCreate`/`CronDelete`/`CronList`
 * (and the PR-process MCPs — `get_pr_diff`, `post_review` — were removed, so the
 * reviewer now inspects and posts via `gh` directly). `seedPresetAgents()` runs
 * only at Space creation, so existing Spaces keep the shell-less Reviewer tool
 * profile unless their row is updated. A shell-less reviewer in a stable
 * coder-owned workflow cannot run `gh pr review` / `gh pr view`, so the
 * workflow stalls.
 *
 * What this migration does:
 *   For every Space, for every `space_agents` row that is preset-tracked as the
 *   Reviewer (`template_name = 'Reviewer'`), if its stored `tools` array still
 *   equals the OLD shell-less Reviewer profile (i.e. it is an unmodified seed,
 *   not a user customization), replace `tools` with the current preset's tool
 *   list and re-stamp `template_hash`.
 *
 * Safety: a row whose tools differ from the old seed profile is a user
 * customization and is left untouched (the drift/sync UI surfaces it normally).
 * Idempotent: re-running finds the row already at the current profile and skips.
 */

import type { Database as BunDatabase } from '../sqlite-compat';
import { getPresetAgentTemplates } from '../../lib/space/agents/seed-agents';
import { computeAgentTemplateHash } from '../../lib/space/agents/agent-template-hash';
import { Logger } from '../../lib/logger';

const log = new Logger('migration-179');

// The pre-change Reviewer profile (shell-less, no cron) — rows whose stored
// tools exactly match this set are unmodified seeds and safe to re-stamp.
const OLD_REVIEWER_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'Skill',
  'ToolSearch',
  'Task',
  'TaskOutput',
  'TaskStop',
];

function tableExists(db: BunDatabase, tableName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
  return !!result;
}

function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
  return !!db
    .prepare(`SELECT name FROM pragma_table_info('${tableName}') WHERE name = ?`)
    .get(columnName);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((v) => set.has(v));
}

export function runMigration179(db: BunDatabase): void {
  if (!tableExists(db, 'space_agents')) return;

  // Guard against partially-migrated / sentinel schemas (the marker-seed path):
  // only touch rows when the columns this migration reads all exist. A minimal
  // `space_agents` table (e.g. `id` only) is a legacy sentinel, not a real
  // seeded space — there is nothing to re-stamp there.
  if (
    !tableHasColumn(db, 'space_agents', 'template_name') ||
    !tableHasColumn(db, 'space_agents', 'tools') ||
    !tableHasColumn(db, 'space_agents', 'template_hash')
  ) {
    return;
  }

  const presets = getPresetAgentTemplates();
  const reviewer = presets.find((preset) => preset.name === 'Reviewer');
  if (!reviewer) return;

  const rows = db
    .prepare(`SELECT id, tools, template_hash FROM space_agents WHERE template_name = 'Reviewer'`)
    .all() as Array<{ id: string; tools: string | null; template_hash: string | null }>;

  const update = db.prepare(`UPDATE space_agents SET tools = ?, template_hash = ? WHERE id = ?`);
  let updated = 0;

  for (const row of rows) {
    let storedTools: string[] = [];
    try {
      const parsed = row.tools ? JSON.parse(row.tools) : [];
      storedTools = Array.isArray(parsed) ? parsed.map((t) => String(t)) : [];
    } catch {
      // Malformed tools JSON — not a clean seed; leave it for drift/sync.
      continue;
    }
    // Only unmodified seeds (exact old profile) are re-stamped. A row whose
    // tools differ is a user customization — never overwrite it.
    if (!arraysEqual(storedTools, OLD_REVIEWER_TOOLS)) continue;

    update.run(JSON.stringify(reviewer.tools), computeAgentTemplateHash(reviewer), row.id);
    updated++;
  }

  if (updated > 0) {
    log.info(`[backfill] Re-stamped Bash+Cron tools on ${updated} Reviewer preset row(s).`);
  }
}
