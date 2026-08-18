import type { Database as BunDatabase } from '../sqlite-compat';

interface ChannelRow {
  id?: string;
  from?: string;
  to?: string | string[];
  maxCycles?: number;
  gateId?: string;
  label?: string;
}

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
  if (!columnExists(db, 'space_workflows', 'name')) return;
  if (!columnExists(db, 'space_workflows', 'channels')) return;
  const hasTemplateCol = columnExists(db, 'space_workflows', 'template_name');
  const selectCols = ['id', 'name', hasTemplateCol ? 'template_name' : null, 'channels']
    .filter(Boolean)
    .join(', ');
  const nodesTableExists = !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='space_workflow_nodes'`)
    .get();
  const nodeRowsFor = nodesTableExists
    ? db.prepare(`SELECT name, config FROM space_workflow_nodes WHERE workflow_id = ?`)
    : null;

  const rows = db.prepare(`SELECT ${selectCols} FROM space_workflows`).all() as {
    id: string;
    name: string;
    template_name?: string | null;
    channels: string | null;
  }[];

  const update = db.prepare(`UPDATE space_workflows SET channels = ? WHERE id = ?`);

  for (const row of rows) {
    if (hasTemplateCol) {
      if (!row.template_name || !TARGET_WORKFLOW_NAMES.has(row.template_name)) continue;
    } else if (!TARGET_WORKFLOW_NAMES.has(row.name)) {
      continue;
    }
    const nodeRows = nodeRowsFor
      ? (nodeRowsFor.all(row.id) as Array<{ name: string | null; config: string | null }>)
      : [];
    const slotToName = buildSlotToNodeName(nodeRows);
    const postApproval = slotToName.get('merger') ?? 'Post-Approval';
    const review = slotToName.get('reviewer') ?? 'Review';
    const qa = slotToName.get('qa') ?? 'QA';

    const channels = parseChannels(row.channels);
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
    if (augmented.length === channels.length) continue;
    update.run(JSON.stringify(augmented), row.id);
  }
}
