/**
 * Migration 94 — Backfill workflow template tracking & remove orphan duplicates.
 *
 * Context: earlier versions of `seedBuiltInWorkflows()` predated the
 * `template_name` / `template_hash` columns, so existing Spaces ended up with
 * workflows that match a built-in template by name but have
 * `template_name = NULL` (which broke drift detection and the "Sync from
 * template" UI).
 *
 * This migration realigns legacy rows with the current built-in templates:
 *   1. For each `space_workflows` row whose (name, node names, fingerprint)
 *      structurally matches a known built-in, set `template_name` +
 *      `template_hash` if missing.
 *   2. Delete orphan duplicate workflows — same (space_id, name) as a newer
 *      row, older `created_at`, and no active `space_workflow_runs` references.
 *      Keeps the newer row; drops the earlier superseded seed.
 *
 * Historical note: an earlier revision of this migration also reattached an
 * end-node `completionActions` JSON entry on rows where it was missing. That
 * pipeline was deleted in PR 4/5 of the
 * task-agent-as-post-approval-executor refactor and the underlying columns are
 * dropped in M104, so the backfill is no longer needed. Any residual
 * `completionActions` JSON on existing node rows is silently ignored at load
 * time (see `space-workflow-repository.ts#rowToNode`).
 *
 * The migration is idempotent: re-running it on a DB that has already been
 * backfilled is a no-op (template hashes only get rewritten when they differ).
 *
 * Self-contained by design — migrations must not depend on runtime app logic
 * that may drift over time. The built-in template shapes embedded here reflect
 * the state of the templates at the time this migration was authored; that
 * matches exactly what the DB needs to be aligned to.
 */

import type { Database as BunDatabase } from '../sqlite-compat';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Template fingerprints (frozen copy of the built-in templates' hashable shape
// — node names, channels, gates, description, instructions).
//
// These MUST match exactly what `computeWorkflowHash(template)` produces for
// the current built-in templates. If the built-in templates change, add a
// follow-up migration rather than modifying this one — migrations are
// historical.
// ---------------------------------------------------------------------------

interface GateField {
  name: string;
  type: string;
  check:
    | { op: 'exists' }
    | { op: '=='; value: unknown }
    | { op: 'count'; match: string; min: number };
}

interface GateShape {
  id: string;
  requiredLevel?: number;
  resetOnCycle?: boolean;
  fields: GateField[];
  scriptSource?: string;
}

interface ChannelShape {
  from: string;
  to: string | string[];
}

interface TemplateShape {
  name: string;
  description: string;
  instructions: string;
  nodeNames: string[];
  /** Name of the end node — preserved for symmetry with the historical shape. */
  endNodeName: string;
  channels: ChannelShape[];
  gates: GateShape[];
}

// First 64 chars of `PR_READY_BASH_SCRIPT` (joined with \n) — matches what
// `computeWorkflowHash` captures via `g.script.source.slice(0, 64)`. Must be
// exactly 64 characters; any shorter and `fingerprintMatches` becomes dead
// code for templates with scripted gates (Coding, Research, Plan & Decompose,
// Coding+QA) and the migration falls back to the row's own hash.
const PR_READY_SCRIPT_PREFIX = '# Prefer explicit PR URL from gate data JSON when available; fal';

/**
 * Known built-in templates and their fingerprints.
 * Order is not significant — matched by `name`.
 */
const KNOWN_TEMPLATES: TemplateShape[] = [
  {
    name: 'Coding Workflow',
    description:
      'Iterative coding workflow with Coding ↔ Review loop. Engineer implements and opens a PR; Reviewer reviews and either requests changes or signals completion.',
    instructions: '',
    nodeNames: ['Coding', 'Review'],
    endNodeName: 'Review',
    channels: [
      { from: 'Coding', to: 'Review' },
      { from: 'Review', to: 'Coding' },
    ],
    gates: [
      {
        id: 'code-ready-gate',
        resetOnCycle: true,
        fields: [{ name: 'pr_url', type: 'string', check: { op: 'exists' } }],
        scriptSource: PR_READY_SCRIPT_PREFIX,
      },
    ],
  },
  {
    name: 'Research Workflow',
    description:
      'Iterative research workflow with gated PR verification. Research agent investigates and opens a PR; Reviewer evaluates findings and requests revisions if needed.',
    instructions: '',
    nodeNames: ['Research', 'Review'],
    endNodeName: 'Review',
    channels: [
      { from: 'Research', to: 'Review' },
      { from: 'Review', to: 'Research' },
    ],
    gates: [
      {
        id: 'research-ready-gate',
        resetOnCycle: true,
        fields: [{ name: 'pr_url', type: 'string', check: { op: 'exists' } }],
        scriptSource: PR_READY_SCRIPT_PREFIX,
      },
    ],
  },
  {
    name: 'Review-Only Workflow',
    description:
      'Single-node review workflow with no planning phase. Reviewer evaluates directly; the run completes when done.',
    instructions: '',
    nodeNames: ['Review'],
    endNodeName: 'Review',
    channels: [],
    gates: [],
  },
  {
    name: 'Plan & Decompose Workflow',
    description:
      'Decompose a broad user goal into standalone follow-up tasks. A Planner writes a plan PR, ' +
      'four parallel Reviewers (architecture, security, correctness, UX) approve, and a Task ' +
      'Dispatcher fans the approved plan out into individual tasks via `create_standalone_task`. ' +
      'Task Dispatcher is the terminal node.',
    instructions: '',
    nodeNames: ['Planning', 'Plan Review', 'Task Dispatcher'],
    endNodeName: 'Task Dispatcher',
    channels: [
      { from: 'Planning', to: 'Plan Review' },
      { from: 'Plan Review', to: 'Task Dispatcher' },
      { from: 'Plan Review', to: 'Planning' },
    ],
    gates: [
      {
        id: 'plan-pr-gate',
        resetOnCycle: true,
        fields: [{ name: 'pr_url', type: 'string', check: { op: 'exists' } }],
        scriptSource: PR_READY_SCRIPT_PREFIX,
      },
      {
        id: 'plan-approval-gate',
        resetOnCycle: true,
        fields: [
          { name: 'approvals', type: 'map', check: { op: 'count', match: 'approved', min: 4 } },
        ],
      },
    ],
  },
  {
    name: 'Coding with QA Workflow',
    description:
      'Coder ↔ Reviewer loop with explicit QA validation before completion. ' +
      'Designed for backend+frontend changes that require thorough test coverage, including browser tests.',
    instructions: '',
    nodeNames: ['Coding', 'Review', 'QA'],
    endNodeName: 'QA',
    channels: [
      { from: 'Coding', to: 'Review' },
      { from: 'Review', to: 'QA' },
      { from: 'Review', to: 'Coding' },
      { from: 'QA', to: 'Coding' },
    ],
    gates: [
      {
        id: 'code-pr-gate',
        resetOnCycle: true,
        fields: [{ name: 'pr_url', type: 'string', check: { op: 'exists' } }],
        scriptSource: PR_READY_SCRIPT_PREFIX,
      },
      {
        id: 'review-approval-gate',
        resetOnCycle: true,
        fields: [{ name: 'approved', type: 'boolean', check: { op: '==', value: true } }],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Canonical fingerprint / hash — frozen historical copy.
//
// This mirrors the shape of `template-hash.ts` AS OF the M94 authoring date
// (commit 6c13c7a7a). The production fingerprint in
// `packages/daemon/src/lib/space/workflows/template-hash.ts` has since grown
// additional fields (nodePrompts, completionAutonomyLevel, postApproval).
//
// We intentionally do NOT update this migration to track the evolving
// fingerprint: M94 is a one-shot backfill that runs against pre-M94 DBs, and
// the seeder re-stamps `template_content_hash` on every daemon start using
// the live fingerprint. So the only role of this hash is to mark the row as
// "templated" with a deterministic value — drift is corrected at startup.
// ---------------------------------------------------------------------------

interface WorkflowFingerprint {
  description: string;
  instructions: string;
  nodeNames: string[];
  channels: string[];
  gates: string[];
}

function serializeGate(gate: GateShape): string {
  const fields = gate.fields
    .map((f) => {
      const check = f.check;
      let checkStr = check.op;
      if (check.op === 'count') {
        checkStr += `:${String(check.match)}:${check.min}`;
      } else if (check.op !== 'exists' && 'value' in check && check.value !== undefined) {
        checkStr += `:${String(check.value)}`;
      }
      return `${f.name}:${f.type}:${checkStr}`;
    })
    .sort()
    .join(',');
  const scriptPrefix = gate.scriptSource ? gate.scriptSource.slice(0, 64) : '';
  // Matches production `template-hash.ts#buildWorkflowFingerprint` exactly — do
  // NOT coerce resetOnCycle to a default value here; stringifying `undefined`
  // is intentional in the canonical serialization.
  return `${gate.id}|${gate.requiredLevel ?? 0}|${gate.resetOnCycle}|${fields}|${scriptPrefix}`;
}

function buildTemplateFingerprint(tpl: TemplateShape): WorkflowFingerprint {
  const nodeNames = [...tpl.nodeNames].sort();
  const channels = tpl.channels
    .map((c) => {
      const to = Array.isArray(c.to) ? [...c.to].sort().join(',') : c.to;
      return `${c.from}->${to}`;
    })
    .sort();
  const gates = tpl.gates.map(serializeGate).sort();
  return {
    description: tpl.description ?? '',
    instructions: tpl.instructions ?? '',
    nodeNames,
    channels,
    gates,
  };
}

function buildWorkflowFingerprintFromDb(
  row: WorkflowRow,
  nodeNames: string[]
): WorkflowFingerprint {
  const parsedChannels = parseJson<Array<{ from?: string; to?: string | string[] }>>(
    row.channels,
    []
  );
  const parsedGates = parseJson<
    Array<{
      id?: string;
      requiredLevel?: number;
      resetOnCycle?: boolean;
      fields?: GateField[];
      script?: { source?: string };
    }>
  >(row.gates, []);

  const channels = parsedChannels
    .filter((c) => typeof c.from === 'string' && c.to != null)
    .map((c) => {
      const to = Array.isArray(c.to) ? [...(c.to as string[])].sort().join(',') : (c.to as string);
      return `${c.from}->${to}`;
    })
    .sort();

  const gates = parsedGates
    .map(
      (g): GateShape => ({
        id: g.id ?? '',
        requiredLevel: g.requiredLevel,
        resetOnCycle: g.resetOnCycle,
        fields: Array.isArray(g.fields) ? g.fields : [],
        scriptSource: g.script?.source,
      })
    )
    .map(serializeGate)
    .sort();

  return {
    description: row.description ?? '',
    instructions: row.instructions ?? '',
    nodeNames: [...nodeNames].sort(),
    channels,
    gates,
  };
}

function hashFingerprint(fp: WorkflowFingerprint): string {
  const json = JSON.stringify(fp);
  return createHash('sha256').update(json).digest('hex');
}

// ---------------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------------

interface WorkflowRow {
  id: string;
  space_id: string;
  name: string;
  description: string;
  end_node_id: string | null;
  channels: string | null;
  gates: string | null;
  template_name: string | null;
  template_hash: string | null;
  instructions: string | null;
  created_at: number;
}

interface NodeRow {
  id: string;
  workflow_id: string;
  name: string;
  config: string | null;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
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

// ---------------------------------------------------------------------------
// Migration entrypoint
// ---------------------------------------------------------------------------

export function runMigration94(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflows')) return;
  if (!tableExists(db, 'space_workflow_nodes')) return;
  // Guard on template columns — if they don't exist yet (migration 90 hasn't
  // run), skip silently. The normal migration order runs M90 first.
  if (!tableHasColumn(db, 'space_workflows', 'template_name')) return;
  if (!tableHasColumn(db, 'space_workflows', 'template_hash')) return;

  // Pre-compute template hashes keyed by name.
  const templatesByName = new Map<string, { tpl: TemplateShape; hash: string }>();
  for (const tpl of KNOWN_TEMPLATES) {
    const hash = hashFingerprint(buildTemplateFingerprint(tpl));
    templatesByName.set(tpl.name, { tpl, hash });
  }

  const workflowRows = db
    .prepare(
      `SELECT id, space_id, name, description, end_node_id, channels, gates,
			        template_name, template_hash, instructions, created_at
			   FROM space_workflows`
    )
    .all() as WorkflowRow[];

  const updateWorkflow = db.prepare(
    `UPDATE space_workflows SET template_name = ?, template_hash = ? WHERE id = ?`
  );
  const deleteWorkflow = db.prepare(`DELETE FROM space_workflows WHERE id = ?`);

  // Track which rows are considered "backfilled built-ins" — used below for
  // orphan duplicate detection. (Only consider matched rows; custom user
  // workflows are never deleted.)
  const matchedByKey = new Map<string, WorkflowRow[]>(); // key: `${spaceId}|${name}`

  // -----------------------------------------------------------------------
  // Pass 1 — structural match + backfill template_name/template_hash.
  // -----------------------------------------------------------------------
  for (const row of workflowRows) {
    const known = templatesByName.get(row.name);
    if (!known) continue; // custom workflow — leave alone

    const nodeRows = db
      .prepare(
        `SELECT id, workflow_id, name, config FROM space_workflow_nodes WHERE workflow_id = ?`
      )
      .all(row.id) as NodeRow[];

    const nodeNames = nodeRows.map((n) => n.name);

    // Structural check: node name set must match the template.
    const tplNames = new Set(known.tpl.nodeNames);
    if (
      nodeNames.length !== known.tpl.nodeNames.length ||
      !nodeNames.every((n) => tplNames.has(n))
    ) {
      continue;
    }

    // Fingerprint-hash match — a stronger structural check that verifies
    // description, channels, and gate internals as well. If the row's
    // fingerprint already equals the template hash, it's a true match.
    const rowFp = buildWorkflowFingerprintFromDb(row, nodeNames);
    const rowHash = hashFingerprint(rowFp);
    const fingerprintMatches = rowHash === known.hash;

    // Collect for duplicate detection.
    const key = `${row.space_id}|${row.name}`;
    const bucket = matchedByKey.get(key);
    if (bucket) bucket.push(row);
    else matchedByKey.set(key, [row]);

    // ----- Backfill template_name / template_hash -----
    // Policy: fill in missing template_name if the structure matches the
    // template (we're confident about the link even if the user made minor
    // tweaks). Set template_hash to the computed fingerprint hash of the
    // current row — so drift detection reflects the current state
    // faithfully. If the row matches the template exactly, that equals the
    // canonical template hash.
    const nextTemplateName = row.template_name ?? known.tpl.name;
    const nextTemplateHash = fingerprintMatches ? known.hash : (row.template_hash ?? rowHash);
    if (row.template_name !== nextTemplateName || row.template_hash !== nextTemplateHash) {
      updateWorkflow.run(nextTemplateName, nextTemplateHash, row.id);
      row.template_name = nextTemplateName;
      row.template_hash = nextTemplateHash;
    }
  }

  // -----------------------------------------------------------------------
  // Pass 2 — delete orphan duplicate built-ins. Keep the newest `created_at`
  // per (space_id, name); drop older rows that have no active workflow_run
  // references.
  // -----------------------------------------------------------------------
  const hasRunsTable = tableExists(db, 'space_workflow_runs');
  // "Active" = any non-terminal WorkflowRunStatus. Terminal statuses are
  // `'done'` and `'cancelled'`. See packages/shared/src/types/space.ts.
  const activeRunsCount = hasRunsTable
    ? db.prepare(
        `SELECT COUNT(*) AS n FROM space_workflow_runs
				  WHERE workflow_id = ?
				    AND status IN ('pending', 'in_progress', 'blocked')`
      )
    : null;

  for (const [, rows] of matchedByKey) {
    if (rows.length < 2) continue;
    // Sort newest first
    rows.sort((a, b) => b.created_at - a.created_at);
    const [, ...older] = rows;
    for (const row of older) {
      if (activeRunsCount) {
        const res = activeRunsCount.get(row.id) as { n: number } | undefined;
        if (res && res.n > 0) continue; // keep — has active runs
      }
      deleteWorkflow.run(row.id);
    }
  }
}
