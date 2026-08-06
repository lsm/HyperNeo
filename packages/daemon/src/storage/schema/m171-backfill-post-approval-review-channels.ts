/**
 * Migration 171 — Backfill Post-Approval ↔ Review channels onto built-in
 * merge-capable workflows.
 *
 * The post-approval redesign has the PR Merger (Post-Approval node) report merge
 * blockers to the Reviewer and receive a "re-approved, continue" signal back,
 * instead of self-diagnosing and self-approving. That requires
 * Post-Approval ↔ Review channels on the Coding, Research, and Coding-with-QA
 * built-in workflows. New Spaces get them from the seeder; this migration adds
 * them to EXISTING persisted `space_workflows` rows so the new merger
 * instructions can reach the Reviewer.
 *
 * Idempotent: rows already carrying a `Post-Approval → Review` channel are left
 * unchanged, so re-running is a no-op. Custom (non-built-in) workflows and rows
 * missing the channels column are never touched.
 *
 * Self-contained by design — migrations must not depend on runtime app logic.
 * The channel shapes embedded here mirror the built-in templates as of this
 * migration; subsequent template changes get their own follow-up migration.
 */
import type { Database as BunDatabase } from '../sqlite-compat';

interface ChannelRow {
  from?: string;
  to?: string | string[];
  maxCycles?: number;
  gateId?: string;
  label?: string;
}

/** Built-in workflows whose merger needs to reach the Reviewer. */
const TARGET_WORKFLOW_NAMES = new Set([
  'Coding Workflow',
  'Research Workflow',
  'Coding with QA Workflow',
]);

function parseChannels(raw: string | null | undefined): ChannelRow[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChannelRow[]) : [];
  } catch {
    return [];
  }
}

function columnExists(db: BunDatabase, tableName: string, columnName: string): boolean {
  return !!db
    .prepare(`SELECT name FROM pragma_table_info('${tableName}') WHERE name = ?`)
    .get(columnName);
}

export function runMigration171(db: BunDatabase): void {
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='space_workflows'`)
    .get();
  if (!tableExists) return;
  // Partial schemas (e.g. baseline-sentinel fixtures in migration-runner tests)
  // may have a `space_workflows` table without the full column set — skip those;
  // the backfill only applies once the real schema (with `name` + `channels`) is
  // present.
  if (!columnExists(db, 'space_workflows', 'name')) return;
  if (!columnExists(db, 'space_workflows', 'channels')) return;
  // `template_name` is the canonical built-in identifier (it survives a user
  // renaming the workflow, and it's null for custom workflows). Prefer it; fall
  // back to `name` only for legacy rows seeded before template tracking (m90).
  const hasTemplateCol = columnExists(db, 'space_workflows', 'template_name');
  const selectCols = hasTemplateCol ? 'id, name, template_name, channels' : 'id, name, channels';

  const rows = db.prepare(`SELECT ${selectCols} FROM space_workflows`).all() as {
    id: string;
    name: string;
    template_name?: string | null;
    channels: string | null;
  }[];

  const update = db.prepare(`UPDATE space_workflows SET channels = ? WHERE id = ?`);

  for (const row of rows) {
    // When the template_name column exists, match STRICTLY by it (the canonical
    // built-in id; a NULL template_name means custom, even if it reuses a
    // built-in display name). The name fallback only applies to schemas that
    // predate the template_name column entirely.
    if (hasTemplateCol) {
      if (!row.template_name || !TARGET_WORKFLOW_NAMES.has(row.template_name)) continue;
    } else if (!TARGET_WORKFLOW_NAMES.has(row.name)) {
      continue;
    }
    const channels = parseChannels(row.channels);
    // Append ONLY the directions that are absent — never remove or overwrite an
    // existing channel (a user may have customized its gateId, maxCycles, etc.).
    const augmented = [...channels];
    const hasDir = (from: string, to: string): boolean =>
      channels.some((c) => c.from === from && c.to === to);
    if (!hasDir('Post-Approval', 'Review')) {
      augmented.push({
        from: 'Post-Approval',
        to: 'Review',
        maxCycles: 5,
        label: 'Post-Approval → Review (merge blocker report)',
      });
    }
    if (!hasDir('Review', 'Post-Approval')) {
      augmented.push({
        from: 'Review',
        to: 'Post-Approval',
        maxCycles: 5,
        label: 'Review → Post-Approval (re-approved, continue)',
      });
    }
    if (augmented.length === channels.length) continue; // both already present
    update.run(JSON.stringify(augmented), row.id);
  }
}
