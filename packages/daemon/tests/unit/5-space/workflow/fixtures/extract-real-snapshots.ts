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

const TRIM_KEYS = new Set(['value', 'instructions']);

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

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

function countValidatorKinds(hooks: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!Array.isArray(hooks)) return counts;
  for (const h of hooks) {
    const v = (h as { validator?: { kind?: string; id?: string } }).validator;
    const key = v?.kind === 'built_in' ? `built_in:${v.id}` : (v?.kind ?? 'none');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function collectGateIds(gates: unknown, channels: unknown): string[] {
  const ids = new Set<string>();
  if (Array.isArray(gates)) {
    for (const g of gates) {
      const id = (g as { id?: string }).id;
      if (id) ids.add(id);
    }
  }
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
              template_hash AS templateHash, channels, gates, hooks
       FROM space_workflows
       WHERE template_name = ? AND hooks IS NOT NULL
       LIMIT 1`
    )
    .get(templateName) as {
    id: string;
    templateName: string;
    completionAutonomyLevel: number;
    templateHash: string | null;
    channels: string | null;
    gates: string | null;
    hooks: string | null;
  } | null;

  if (!row) {
    console.warn(`no row with hooks for ${templateName}, skipping`);
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

  const snapshot = sanitize({
    templateName: row.templateName,
    completionAutonomyLevel: row.completionAutonomyLevel,
    templateHash: row.templateHash,
    channels: row.channels ? JSON.parse(row.channels) : null,
    gates: row.gates ? JSON.parse(row.gates) : null,
    hooks: row.hooks ? JSON.parse(row.hooks) : null,
    nodes,
  }) as Record<string, unknown>;

  const summary = {
    hookValidatorKinds: countValidatorKinds(snapshot.hooks),
    gateIds: collectGateIds(snapshot.gates, snapshot.channels),
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
