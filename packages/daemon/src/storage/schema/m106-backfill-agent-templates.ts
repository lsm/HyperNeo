/**
 * Migration 106 — Backfill preset agent template tracking.
 *
 * Context: M105 added `template_name` / `template_hash` columns to
 * `space_agents`, but every row seeded before M105 has those columns
 * NULL. Drift detection silently skips rows with `template_name = NULL`,
 * so without a backfill the new "Sync from template" button would never
 * appear on existing spaces — even though those spaces clearly seeded
 * preset agents.
 *
 * What this migration does:
 *   For each `space_agents` row with `template_name = NULL` whose
 *   normalized name matches a known preset name (case-insensitive),
 *   set `template_name` to the canonical preset name and `template_hash`
 *   to the SHA-256 fingerprint of the row's CURRENT field values
 *   (description, tools, customPrompt). Hashing the row — not the live
 *   preset — preserves any user customisations: drift detection then
 *   surfaces those rows as "out of sync" and the user can opt into the
 *   sync via the UI button.
 *
 * Self-contained by design — migrations must not depend on runtime app
 * logic that may drift over time. The preset name list and the hashing
 * logic are inlined here so the migration's behaviour is frozen at the
 * time it was authored.
 *
 * Idempotent: re-running on a DB whose rows already have `template_name`
 * is a no-op (we only touch rows where `template_name IS NULL`).
 *
 * Mirrors the pattern used by `m94-backfill-workflow-templates.ts`.
 */

import type { Database as BunDatabase } from 'bun:sqlite';

// ---------------------------------------------------------------------------
// Frozen preset name set — the six built-in presets seeded by
// `seedPresetAgents()` at the time M106 was authored. Matched
// case-insensitively against the row's `name` column.
// ---------------------------------------------------------------------------

const KNOWN_PRESET_NAMES = ['Coder', 'General', 'Planner', 'Research', 'Reviewer', 'QA'] as const;

// ---------------------------------------------------------------------------
// Canonical fingerprint / hash — frozen historical copy. Mirrors the live
// `agent-template-hash.ts` AS OF the M106 authoring date. We deliberately
// inline this rather than importing the runtime utility so that the
// migration's behaviour is stable across future template format changes.
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

export function runMigration106(db: BunDatabase): void {
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

    const hash = hashAgentFingerprint({
      name: canonicalName,
      description: row.description ?? '',
      tools: parseTools(row.tools),
      customPrompt: row.custom_prompt ?? '',
    });

    update.run(canonicalName, hash, row.id);
  }
}
