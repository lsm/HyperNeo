/**
 * Migration 170 — Re-backfill orphaned preset agent template tracking.
 *
 * Context: M106 backfilled `template_name` / `template_hash` on preset-named
 * `space_agents` rows that predated template tracking. But M106 is a one-shot
 * marked migration: once it ran on a database it never runs again. Rows can
 * become orphaned AGAIN after M106 — most commonly because editing a preset
 * agent's template-defining fields in the UI clears tracking
 * (`SpaceAgentEditor` sets `templateName: null, templateHash: null` whenever
 * the description / tools / customPrompt diverge), or because the rows were
 * seeded after M106 by a code path that didn't stamp tracking. Once orphaned,
 * a row is invisible to drift detection (`getAgentDriftReport` historically
 * `continue`d on `!templateName`), so its prompt silently goes stale (e.g. the
 * NeoKai → HyperNeo rebrand never propagates) and there is no UI path to reset.
 *
 * What this migration does:
 *   For each `space_agents` row with `template_name IS NULL` whose normalized
 *   name matches a known preset (case-insensitive):
 *     - Matching row  → stamp `template_name` (canonical) and `template_hash`
 *                       (the preset hash, which equals the row hash). Drift
 *                       then reads the row as in-sync, silently cleaning up
 *                       the orphan with no badge noise.
 *     - Divergent row → LEAVE it as an orphan. Drift detection's orphan path
 *                       then marks it `updateAvailable: true, customized: true`,
 *                       which the UI renders as "Re-attach to preset" with a
 *                       forced "Review diff" — so the user sees exactly what
 *                       changes (the NeoKai → HyperNeo rebrand, or their own
 *                       local edits) before anything is overwritten.
 *
 * Why divergent rows are deliberately left as orphans (and NOT stamped with
 * the row hash the way M106 does): M106 stamps `template_hash` to the row's
 * own fingerprint, which makes `customized = rowHash !== storedHash` always
 * false. The UI then offers a direct "Apply" backed only by a generic confirm
 * — clicking it would silently overwrite a user's local edits with no
 * field-level diff review. Stamping the preset hash instead would make
 * `updateAvailable` false and hide stale prompts entirely (the migration's
 * whole purpose). A one-shot backfill cannot tell a stale-preset row from a
 * user-edited row — both look like "row ≠ preset" — so the only safe choice is
 * to route both through the orphan path, which forces a diff review before any
 * overwrite.
 *
 * Unlike M106, this migration imports the live preset definitions and the hash
 * function (`getPresetAgentTemplates` / `computeAgentTemplateHash`) so its
 * notion of "matches the current preset" is byte-identical to the drift
 * report's. The migration is still marked one-shot (runs once per DB);
 * comparing against the preset as it exists when the migration runs is exactly
 * what we want.
 *
 * Idempotent: re-running only touches rows where `template_name IS NULL`.
 * Matching rows get stamped (then skipped on re-run); divergent rows stay NULL
 * and are re-evaluated each run — if a later preset change or user edit makes
 * them match, they get re-attached then. Safe on spaces already correctly
 * tracked.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { getPresetAgentTemplates } from '../../lib/space/agents/seed-agents';
import { computeAgentTemplateHash } from '../../lib/space/agents/agent-template-hash';

// ---------------------------------------------------------------------------
// DB row shape
// ---------------------------------------------------------------------------

interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  tools: string | null;
  custom_prompt: string | null;
  template_name: string | null;
  template_hash: string | null;
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
  return !!result;
}

function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM pragma_table_info('${tableName}') WHERE name = ?`)
    .get(columnName);
  return !!result;
}

function parseTools(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed.filter((t) => typeof t === 'string') as string[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Migration entrypoint
// ---------------------------------------------------------------------------

export function runMigration170(db: BunDatabase): void {
  if (!tableExists(db, 'space_agents')) return;
  // Guard on the template columns existing — if M105 hasn't run yet (in
  // practice it always does, runMigrations runs them in order), skip.
  if (!tableHasColumn(db, 'space_agents', 'template_name')) return;
  if (!tableHasColumn(db, 'space_agents', 'template_hash')) return;

  // Live preset definitions, keyed by normalized name. Imported (not inlined)
  // so the migration's "matches the current preset" check is identical to the
  // drift report's comparison.
  const presetByLowerName = new Map(
    getPresetAgentTemplates().map((p) => [p.name.toLowerCase(), p])
  );

  const rows = db
    .prepare(
      `SELECT id, name, description, tools, custom_prompt, template_name, template_hash
           FROM space_agents
          WHERE template_name IS NULL`
    )
    .all() as AgentRow[];

  if (rows.length === 0) return;

  const update = db.prepare(
    `UPDATE space_agents SET template_name = ?, template_hash = ? WHERE id = ?`
  );

  for (const row of rows) {
    const normalized = (row.name ?? '').trim().toLowerCase();
    const preset = presetByLowerName.get(normalized);
    if (!preset) continue; // user-created agent — leave alone

    const rowHash = computeAgentTemplateHash({
      name: row.name ?? '',
      description: row.description ?? '',
      tools: parseTools(row.tools),
      customPrompt: row.custom_prompt ?? '',
    });
    const presetHash = computeAgentTemplateHash(preset);

    // Only re-attach when the row already matches the current preset. A
    // divergent row is left as an orphan so drift detection's orphan path
    // forces a diff review before any overwrite (see module docstring).
    if (rowHash !== presetHash) continue;

    update.run(preset.name, presetHash, row.id);
  }
}
