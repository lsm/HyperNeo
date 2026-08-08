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

const log = new Logger('migration-180');

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

// Distinctive markers of the OLD (pre-change) Reviewer seed prompt + description.
// A row whose stored prompt/description still carry these is a pristine old seed;
// a row without them has a user-customized prompt/description and must NOT be
// overwritten. (Exact-string matching against the full old contract would be
// brittle; these markers are unique to the old seed's no-shell / post_review text.)
const OLD_REVIEWER_PROMPT_MARKER = 'You have no shell in workflow reviewer sessions';
const OLD_REVIEWER_DESCRIPTION_MARKER = 'Has no shell — posts reviews via the post_review tool.';

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

export function runMigration180(db: BunDatabase): void {
  if (!tableExists(db, 'space_agents')) return;

  // Guard against partially-migrated / sentinel schemas (the marker-seed path):
  // only touch rows when the columns this migration reads all exist. A minimal
  // `space_agents` table (e.g. `id` only) is a legacy sentinel, not a real
  // seeded space — there is nothing to re-stamp there.
  if (
    !tableHasColumn(db, 'space_agents', 'template_name') ||
    !tableHasColumn(db, 'space_agents', 'tools') ||
    !tableHasColumn(db, 'space_agents', 'custom_prompt') ||
    !tableHasColumn(db, 'space_agents', 'description') ||
    !tableHasColumn(db, 'space_agents', 'template_hash')
  ) {
    return;
  }

  const presets = getPresetAgentTemplates();
  const reviewer = presets.find((preset) => preset.name === 'Reviewer');
  if (!reviewer) return;

  const rows = db
    .prepare(
      `SELECT id, tools, custom_prompt, description, template_hash FROM space_agents WHERE template_name = 'Reviewer'`
    )
    .all() as Array<{
    id: string;
    tools: string | null;
    custom_prompt: string | null;
    description: string | null;
    template_hash: string | null;
  }>;

  const update = db.prepare(
    `UPDATE space_agents SET tools = ?, custom_prompt = ?, description = ?, template_hash = ? WHERE id = ?`
  );
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
    // Only pristine unmodified seeds are fully re-stamped. A row is an
    // unmodified seed ONLY when BOTH the tool list AND the prompt/description
    // still carry the old seed's values — matching tools alone is NOT proof the
    // prompt/description are unchanged (a user may have customized them while
    // keeping the tool list). A row whose tools differ, or whose prompt/
    // description no longer carry the old seed markers, is a user customization
    // and is left to the drift/sync UI (which already flags it update-available).
    const promptIsOldSeed =
      typeof row.custom_prompt === 'string' &&
      row.custom_prompt.includes(OLD_REVIEWER_PROMPT_MARKER);
    const descriptionIsOldSeed =
      typeof row.description === 'string' &&
      row.description.includes(OLD_REVIEWER_DESCRIPTION_MARKER);
    if (
      !arraysEqual(storedTools, OLD_REVIEWER_TOOLS) ||
      !promptIsOldSeed ||
      !descriptionIsOldSeed
    ) {
      continue;
    }

    // Migrate the WHOLE preset for an unmodified seed, not just tools: the old
    // seed's customPrompt still says the reviewer has no shell and must use the
    // now-removed get_pr_diff / post_review tools. If we only wrote tools but
    // stamped the current hash (whose fingerprint includes customPrompt +
    // description), the stored prompt would keep the obsolete no-shell guidance
    // while `updateAvailable` collapses to false — so existing reviewers get
    // contradictory instructions with no sync offered. Writing the full preset
    // keeps the row genuinely current.
    update.run(
      JSON.stringify(reviewer.tools),
      reviewer.customPrompt,
      reviewer.description,
      computeAgentTemplateHash(reviewer),
      row.id
    );
    updated++;
  }

  if (updated > 0) {
    log.info(`[backfill] Re-stamped Reviewer preset row(s) with Bash+Cron tools and prompt.`);
  }
}
