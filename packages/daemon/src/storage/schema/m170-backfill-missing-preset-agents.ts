/**
 * Migration 170 — Backfill missing preset agents into existing Spaces.
 *
 * Context: `seedPresetAgents()` (seed-agents.ts) runs ONLY at Space creation.
 * When a new preset is added to `PRESET_AGENTS` (most recently "PR Merger" —
 * added as the post-approval shell-capable agent per the role-separation
 * refactor), existing Spaces never receive the new `space_agents` row.
 * M94/M106 only stamp `template_name`/`template_hash` on rows that already
 * exist; they never INSERT newly-added presets.
 *
 * Symptom: a workflow template that references the new preset fails to sync —
 * `buildTemplateUpdateParams` (space-workflow-handlers.ts) throws because no
 * SpaceWorkerAgent resolves the preset's name in the target Space.
 *
 * What this migration does:
 *   For every Space, for every preset in the LIVE `PRESET_AGENTS` list, if no
 *   `space_agents` row exists in that Space whose name matches the preset name
 *   (case-insensitive), INSERT one with the preset's canonical field values —
 *   exactly the row `seedPresetAgents()` would have written at creation time
 *   (name, handle, description, tools, customPrompt, thinkingLevel,
 *   templateName, templateHash).
 *
 * Why the live list (not frozen like M106): M106 only stamped template
 * tracking on rows that already existed, so it froze the preset name set +
 * hashing logic for deterministic re-derivation. This migration INSERTS rows
 * that are missing, so it must use the current preset definitions to produce
 * correct field values — importing `getPresetAgentTemplates()` and
 * `computeAgentTemplateHash()` means future edits to `PRESET_AGENTS` field
 * values propagate without a parallel edit here. Idempotency comes from the
 * name-match check: re-running on a backfilled Space finds every preset name
 * present and inserts nothing.
 *
 * Does NOT modify existing rows. A Space that already has a same-named row
 * (whether `template_name` is set or NULL — the NULL case is a user-customized
 * agent that happens to share a preset name, already hash-stamped by M106) is
 * left untouched. Only missing presets are inserted.
 *
 * Idempotent: re-running on an already-backfilled database is a no-op.
 */

import type { Database as BunDatabase } from '../sqlite-compat';
import { generateUUID } from '@hyperneo/shared';
import { getPresetAgentTemplates } from '../../lib/space/agents/seed-agents';
import { computeAgentTemplateHash } from '../../lib/space/agents/agent-template-hash';
import { Logger } from '../../lib/logger';

const log = new Logger('migration-170');

interface SpaceRow {
  id: string;
}

interface AgentNameHandleRow {
  name: string;
  handle: string | null;
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
  return !!result;
}

export function runMigration170(db: BunDatabase): void {
  if (!tableExists(db, 'spaces')) return;
  if (!tableExists(db, 'space_agents')) return;

  const presets = getPresetAgentTemplates();
  if (presets.length === 0) return;

  // Read only the PK — late backfills must not assume extra `spaces` columns
  // exist (mirrors the m155 coordinator backfill), keeping this robust against
  // partially-migrated / sentinel schemas during the marker-seed path.
  const spaces = db.prepare(`SELECT id FROM spaces`).all() as SpaceRow[];
  if (spaces.length === 0) return;

  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO space_agents (
       id, space_id, name, handle, status, description, model, thinking_level, provider,
       tools, custom_prompt, setting_sources, template_name, template_hash, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let totalInserted = 0;
  const perSpaceLog: string[] = [];

  for (const space of spaces) {
    // Build the set of existing names (lower-cased) and handles so we only
    // insert presets that are genuinely missing, and never clobber a handle
    // already claimed by a different-named agent.
    const existing = db
      .prepare(`SELECT name, handle FROM space_agents WHERE space_id = ?`)
      .all(space.id) as AgentNameHandleRow[];
    const existingNames = new Set<string>();
    const existingHandles = new Set<string>();
    for (const row of existing) {
      existingNames.add((row.name ?? '').trim().toLowerCase());
      if (row.handle) existingHandles.add(row.handle);
    }

    const insertedNames: string[] = [];
    for (const preset of presets) {
      const lowerName = preset.name.trim().toLowerCase();
      // Name already present (preset or user agent) — never touch existing rows.
      if (existingNames.has(lowerName)) continue;
      // Handle collision guard: a different-named agent already claimed this
      // canonical handle. Skip rather than create a duplicate handle in the
      // Space (rare, but don't silently corrupt handle uniqueness). Ops can
      // resolve manually.
      if (preset.handle && existingHandles.has(preset.handle)) {
        log.warn(
          `[backfill] Skipped preset "${preset.name}" in space ${space.id}: ` +
            `handle "${preset.handle}" is already in use by another agent.`
        );
        continue;
      }

      insert.run(
        generateUUID(),
        space.id,
        preset.name,
        preset.handle,
        'active',
        preset.description,
        null, // model — presets don't pin a model; inherits Space/app default
        preset.thinkingLevel ?? null,
        null, // provider
        JSON.stringify(preset.tools),
        preset.customPrompt,
        null, // setting_sources
        preset.name,
        computeAgentTemplateHash(preset),
        now,
        now
      );

      // Record the new name/handle so later presets in the same Space don't
      // double-insert or collide with one we just added.
      existingNames.add(lowerName);
      if (preset.handle) existingHandles.add(preset.handle);
      insertedNames.push(preset.name);
      totalInserted++;
    }

    if (insertedNames.length > 0) {
      perSpaceLog.push(`space ${space.id}: ${insertedNames.join(', ')}`);
    }
  }

  if (totalInserted > 0) {
    log.info(
      `[backfill] Inserted ${totalInserted} missing preset agent row(s) across ` +
        `${perSpaceLog.length} space(s).`
    );
    for (const line of perSpaceLog) {
      log.info(`[backfill] ${line}`);
    }
  }
}
