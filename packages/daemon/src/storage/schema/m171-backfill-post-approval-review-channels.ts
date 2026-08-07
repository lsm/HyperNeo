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
 * Endpoint resolution: a user may have RENAMED a built-in node (e.g. "Review" →
 * "Code Review"). The persisted workflow's existing channels use the renamed
 * names, so backfilling channels with the canonical "Review"/"Post-Approval"/"QA"
 * literals would produce endpoints that name no node and the merger would stall.
 * The migration therefore resolves each canonical endpoint to the persisted
 * node name via its stable agent SLOT ('merger' → Post-Approval, 'reviewer' →
 * Review, 'qa' → QA), falling back to the canonical name only when the slot
 * can't be found. (The normal `mergeChannelsFromTemplate` re-stamp path does the
 * same remapping; this brings the one-time backfill to parity.)
 *
 * Self-contained by design — migrations must not depend on runtime app logic.
 * The channel shapes embedded here mirror the built-in templates as of this
 * migration; subsequent template changes get their own follow-up migration.
 */
import type { Database as BunDatabase } from '../sqlite-compat';

interface ChannelRow {
  id?: string;
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

/**
 * Build a map of agent-slot name → persisted node name from a workflow's
 * `space_workflow_nodes` rows. Used to resolve canonical endpoint names
 * ("Review", "Post-Approval", "QA") to the names actually used in a (possibly
 * renamed) persisted workflow. Returns an empty map when nodes are missing or
 * unparseable (caller falls back to the canonical names).
 */
function buildSlotToNodeName(
  nodeRows: Array<{ name: string | null; config: string | null }>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of nodeRows) {
    const nodeName = row.name;
    if (typeof nodeName !== 'string' || !nodeName) continue;
    let agents: Array<{ name?: unknown }> = [];
    try {
      const config = row.config ? (JSON.parse(row.config) as { agents?: unknown }) : {};
      agents = Array.isArray(config.agents) ? config.agents : [];
    } catch {
      /* ignore — unparseable config, skip this node */
    }
    for (const agent of agents) {
      if (agent && typeof agent.name === 'string') map.set(agent.name, nodeName);
    }
  }
  return map;
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
  const selectCols = ['id', 'name', hasTemplateCol ? 'template_name' : null, 'channels']
    .filter(Boolean)
    .join(', ');
  // Nodes live in a separate table (space_workflow_nodes); used to remap
  // canonical endpoint names to persisted (possibly renamed) node names.
  const nodesTableExists = !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='space_workflow_nodes'`)
    .get();
  const nodeRowsFor = db.prepare(
    `SELECT name, config FROM space_workflow_nodes WHERE workflow_id = ?`
  );

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
    // Resolve canonical endpoint names to the persisted node names via the
    // stable agent slots, so a renamed node still gets usable channels.
    const nodeRows = nodesTableExists
      ? (nodeRowsFor.all(row.id) as Array<{ name: string | null; config: string | null }>)
      : [];
    const slotToName = buildSlotToNodeName(nodeRows);
    const postApproval = slotToName.get('merger') ?? 'Post-Approval';
    const review = slotToName.get('reviewer') ?? 'Review';
    const qa = slotToName.get('qa') ?? 'QA';

    const channels = parseChannels(row.channels);
    // Append ONLY the directions that are absent — never remove or overwrite an
    // existing channel (a user may have customized its gateId, maxCycles, etc.).
    const augmented = [...channels];
    const hasDir = (from: string, to: string): boolean =>
      channels.some((c) => {
        if (c.from !== from) return false;
        const targets = Array.isArray(c.to) ? c.to : [c.to];
        return targets.includes(to);
      });
    if (!hasDir(postApproval, review)) {
      augmented.push({
        id: crypto.randomUUID(),
        from: postApproval,
        to: review,
        maxCycles: 5,
        label: 'Post-Approval → Review (merge blocker report)',
      });
    }
    if (!hasDir(review, postApproval)) {
      augmented.push({
        id: crypto.randomUUID(),
        from: review,
        to: postApproval,
        maxCycles: 5,
        label: 'Review → Post-Approval (re-approved, continue)',
      });
    }
    // For the Fullstack workflow, QA is the approval authority (the end node).
    // Backfill Post-Approval ↔ QA alongside the Review channels.
    const builtInId = hasTemplateCol ? (row.template_name ?? null) : row.name;
    if (builtInId === 'Coding with QA Workflow') {
      if (!hasDir(postApproval, qa)) {
        augmented.push({
          id: crypto.randomUUID(),
          from: postApproval,
          to: qa,
          maxCycles: 5,
          label: 'Post-Approval → QA (merge blocker report)',
        });
      }
      if (!hasDir(qa, postApproval)) {
        augmented.push({
          id: crypto.randomUUID(),
          from: qa,
          to: postApproval,
          maxCycles: 5,
          label: 'QA → Post-Approval (re-approved, continue)',
        });
      }
    }
    if (augmented.length === channels.length) continue; // nothing new added
    update.run(JSON.stringify(augmented), row.id);
  }
}
