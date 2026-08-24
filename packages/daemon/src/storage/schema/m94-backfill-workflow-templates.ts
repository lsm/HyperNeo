import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { createHash } from 'node:crypto';

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
  endNodeName: string;
  channels: ChannelShape[];
  gates: GateShape[];
}

const PR_READY_SCRIPT_PREFIX = '# Prefer explicit PR URL from gate data JSON when available; fal';

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

export function runMigration94(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflows')) return;
  if (!tableExists(db, 'space_workflow_nodes')) return;
  if (!tableHasColumn(db, 'space_workflows', 'template_name')) return;
  if (!tableHasColumn(db, 'space_workflows', 'template_hash')) return;

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

  const matchedByKey = new Map<string, WorkflowRow[]>();

  for (const row of workflowRows) {
    const known = templatesByName.get(row.name);
    if (!known) continue;

    const nodeRows = db
      .prepare(
        `SELECT id, workflow_id, name, config FROM space_workflow_nodes WHERE workflow_id = ?`
      )
      .all(row.id) as NodeRow[];

    const nodeNames = nodeRows.map((n) => n.name);

    const tplNames = new Set(known.tpl.nodeNames);
    if (
      nodeNames.length !== known.tpl.nodeNames.length ||
      !nodeNames.every((n) => tplNames.has(n))
    ) {
      continue;
    }

    const rowFp = buildWorkflowFingerprintFromDb(row, nodeNames);
    const rowHash = hashFingerprint(rowFp);
    const fingerprintMatches = rowHash === known.hash;

    const key = `${row.space_id}|${row.name}`;
    const bucket = matchedByKey.get(key);
    if (bucket) bucket.push(row);
    else matchedByKey.set(key, [row]);

    const nextTemplateName = row.template_name ?? known.tpl.name;
    const nextTemplateHash = fingerprintMatches ? known.hash : (row.template_hash ?? rowHash);
    if (row.template_name !== nextTemplateName || row.template_hash !== nextTemplateHash) {
      updateWorkflow.run(nextTemplateName, nextTemplateHash, row.id);
      row.template_name = nextTemplateName;
      row.template_hash = nextTemplateHash;
    }
  }

  const hasRunsTable = tableExists(db, 'space_workflow_runs');
  const activeRunsCount = hasRunsTable
    ? db.prepare(
        `SELECT COUNT(*) AS n FROM space_workflow_runs
				  WHERE workflow_id = ?
				    AND status IN ('pending', 'in_progress', 'blocked')`
      )
    : null;

  for (const [, rows] of matchedByKey) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => b.created_at - a.created_at);
    const [, ...older] = rows;
    for (const row of older) {
      if (activeRunsCount) {
        const res = activeRunsCount.get(row.id) as { n: number } | undefined;
        if (res && res.n > 0) continue;
      }
      deleteWorkflow.run(row.id);
    }
  }
}
