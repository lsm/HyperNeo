/**
 * LOCAL-ONLY fixture extractor — Workflow Hooks v2.
 *
 * Regenerates the `./real-snapshots/*.json` fixtures from a real daemon.db.
 * Not part of any test run (CI has no production DB); run it manually against
 * your local/staging DB when refreshing the snapshots:
 *
 *   bun packages/daemon/tests/unit/5-space/workflow/fixtures/extract-real-snapshots.ts
 *
 * Reads the DB READ-ONLY, picks one persisted workflow per built-in template
 * that carries v2 hook bindings, anonymizes UUIDs, trims bulky prompt text,
 * and writes one sanitized fixture per template. See `real-snapshots/README.md`
 * for the sanitization rules and why these snapshots exist.
 *
 * Usage:
 *   DB_PATH=/path/to/daemon.db bun .../extract-real-snapshots.ts [output_dir]
 */

import { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const DB_PATH = process.env.DB_PATH ?? `${process.env.HOME}/.hyperneo/data/daemon.db`;
const OUT_DIR = process.argv[2] ?? join(dirname(import.meta.path), 'real-snapshots');

const TEMPLATES = [
  'Coding Workflow',
  'Coding with QA Workflow',
  'Research Workflow',
  'Review-Only Workflow',
] as const;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Keys whose values are bulky prompt/instructions TEXT — irrelevant to the
 *  migration and noisy in a fixture, so trimmed to a marker. Script `source`
 *  is NOT in this set: custom hook scripts are migration-relevant and contain
 *  no secrets (generic gh/jq bash). */
const TRIM_KEYS = new Set(['value', 'instructions']);

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Recursively anonymize UUIDs and trim oversized prompt strings. */
function sanitize(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    const anonymized = value.replace(UUID_RE, '00000000-0000-4000-8000-000000000000');
    if (key && TRIM_KEYS.has(key) && anonymized.length > 200) {
      return `<trimmed: ${anonymized.length} chars>`;
    }
    return anonymized;
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, key));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitize(v, k);
    }
    return out;
  }
  return value;
}

/** Summarize the v2 hook layers: how many bindings, which hook ids, how many
 *  custom hooks, and their run kinds. */
function summarizeHooks(
  hookBindings: unknown,
  customHooks: unknown
): {
  bindingCount: number;
  bindingHookIds: string[];
  customHookCount: number;
  customHookIds: string[];
} {
  const bindings = Array.isArray(hookBindings) ? hookBindings : [];
  const customs = Array.isArray(customHooks) ? customHooks : [];
  return {
    bindingCount: bindings.length,
    bindingHookIds: bindings.map((b) => (b as { hookId?: string }).hookId ?? '<missing hookId>'),
    customHookCount: customs.length,
    customHookIds: customs.map((h) => (h as { id?: string }).id ?? '<missing id>'),
  };
}

function collectGateIds(channels: unknown): string[] {
  const ids = new Set<string>();
  if (Array.isArray(channels)) {
    for (const c of channels) {
      const gid = (c as { gateId?: string }).gateId;
      if (gid) ids.add(`${gid} (on channel)`);
    }
  }
  return [...ids];
}

const db = new Database(DB_PATH, { readonly: true });
mkdirSync(OUT_DIR, { recursive: true });

let total = 0;
for (const templateName of TEMPLATES) {
  const row = db
    .prepare(
      `SELECT id, template_name AS templateName, completion_autonomy_level AS completionAutonomyLevel,
              template_hash AS templateHash, channels, hook_bindings, custom_hooks
       FROM space_workflows
       WHERE template_name = ? AND (hook_bindings IS NOT NULL OR custom_hooks IS NOT NULL)
       LIMIT 1`
    )
    .get(templateName) as {
    id: string;
    templateName: string;
    completionAutonomyLevel: number;
    templateHash: string | null;
    channels: string | null;
    hookBindings: string | null;
    customHooks: string | null;
  } | null;

  if (!row) {
    console.warn(`no row with v2 hooks for ${templateName}, skipping`);
    continue;
  }

  const nodeRows = db
    .prepare(
      `SELECT id, name, config FROM space_workflow_nodes WHERE workflow_id = ? ORDER BY created_at ASC`
    )
    .all(row.id) as Array<{ id: string; name: string; config: string | null }>;

  const nodes = nodeRows.map((n) => {
    const cfg = n.config ? JSON.parse(n.config) : {};
    return { id: n.id, name: n.name, ...cfg };
  });

  const hookBindings = row.hookBindings ? JSON.parse(row.hookBindings) : null;
  const customHooks = row.customHooks ? JSON.parse(row.customHooks) : null;

  const snapshot = sanitize({
    templateName: row.templateName,
    completionAutonomyLevel: row.completionAutonomyLevel,
    templateHash: row.templateHash,
    channels: row.channels ? JSON.parse(row.channels) : null,
    hookBindings,
    customHooks,
    nodes,
  }) as Record<string, unknown>;

  const summary = {
    ...summarizeHooks(snapshot.hookBindings, snapshot.customHooks),
    gateIds: collectGateIds(snapshot.channels),
    nodeNames: (snapshot.nodes as Array<{ name: string }>).map((n) => n.name),
  };

  const out = {
    _provenance: 'real persisted snapshot from prod daemon.db (anonymized, prompts trimmed)',
    _templateName: templateName,
    _summary: summary,
    workflow: snapshot,
  };
  const path = `${OUT_DIR}/${slug(templateName)}.json`;
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  console.log(`${templateName} -> ${path}  ${JSON.stringify(summary)}`);
  total++;
}
console.log(`\nwrote ${total} fixtures to ${OUT_DIR}`);
