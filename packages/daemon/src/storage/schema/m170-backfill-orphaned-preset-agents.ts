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
 * What this migration does (same logic as M106, re-run as a new marker so it
 * catches rows M106 can no longer touch):
 *   For each `space_agents` row with `template_name IS NULL` whose normalized
 *   name matches a known preset name (case-insensitive), set `template_name`
 *   to the canonical preset name and `template_hash` to the SHA-256 fingerprint
 *   of the row's CURRENT field values (name/description/tools/customPrompt).
 *
 * Hashing the row — not the live preset — is what makes this safe for
 * customised rows. After the backfill, drift detection compares the stored
 * (row) hash against the live preset hash:
 *   - A row that already matches the current preset hashes equal → reads as
 *     in-sync (updateAvailable false), exactly as if it had been seeded today.
 *   - A divergent row (stale preset version OR a user edit) hashes different
 *     from the live preset → reads as `updateAvailable`, so the UI surfaces an
 *     "Apply" affordance. Applying the preset then fixes the staleness (e.g.
 *     the HyperNeo rebrand) in one click. The row is never silently clobbered:
 *   it is never left reading as fully in-sync when it actually diverges.
 *
 * Self-contained by design — migrations must not depend on runtime app logic
 * that may drift over time. The preset name set and the hashing logic are
 * inlined here so the migration's behaviour is frozen at authoring time.
 *
 * Idempotent: re-running on a DB whose rows already have `template_name` is a
 * no-op (we only touch rows where `template_name IS NULL`). Safe on spaces that
 * are already correctly tracked.
 *
 * Mirrors M106 (`m106-backfill-agent-templates.ts`).
 */

import type { Database as BunDatabase } from 'bun:sqlite';

// ---------------------------------------------------------------------------
// Frozen preset name set — the six built-in presets seeded by
// `seedPresetAgents()` at the time this migration was authored. Matched
// case-insensitively against the row's `name` column. Kept in sync with M106.
// ---------------------------------------------------------------------------

const KNOWN_PRESET_NAMES = ['Coder', 'General', 'Planner', 'Research', 'Reviewer', 'QA'] as const;

// ---------------------------------------------------------------------------
// Canonical fingerprint / hash — frozen historical copy. Mirrors the live
// `agent-template-hash.ts` AS OF the authoring date. Inlined rather than
// imported so the migration's behaviour is stable across future template
// format changes.
// ---------------------------------------------------------------------------

interface AgentFingerprintInput {
  name: string;
  description: string;
  tools: string[];
  customPrompt: string;
}

function buildAgentFingerprint(input: AgentFingerprintInput): {
  name: string;
  description: string;
  tools: string[];
  customPrompt: string;
} {
  return {
    name: (input.name ?? '').trim().toLowerCase(),
    description: input.description ?? '',
    tools: [...(input.tools ?? [])].sort(),
    customPrompt: input.customPrompt ?? '',
  };
}

function hashAgentFingerprint(input: AgentFingerprintInput): string {
  const fp = buildAgentFingerprint(input);
  const json = JSON.stringify(fp);
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(json);
  return hasher.digest('hex');
}

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

  // Lower-case lookup map: normalized name → canonical preset name.
  const presetByLowerName = new Map<string, string>(
    KNOWN_PRESET_NAMES.map((n) => [n.toLowerCase(), n])
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
    const canonicalName = presetByLowerName.get(normalized);
    if (!canonicalName) continue; // user-created agent — leave alone

    // Stamp the row's CURRENT fingerprint so a divergent row reads as
    // updateAvailable (never silently in-sync), and a matching row reads as
    // in-sync. See the module docstring for the full rationale.
    const hash = hashAgentFingerprint({
      name: canonicalName,
      description: row.description ?? '',
      tools: parseTools(row.tools),
      customPrompt: row.custom_prompt ?? '',
    });

    update.run(canonicalName, hash, row.id);
  }
}
