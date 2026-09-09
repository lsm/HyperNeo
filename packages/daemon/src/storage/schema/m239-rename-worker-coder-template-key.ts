import type { SpaceWorkflow } from '@hyperneo/shared';
import {
  getLongHorizonAgentTemplate,
  RELOCATED_FROM_LABEL_PREFIX,
} from '../../lib/space/agents/long-horizon-agent-templates.ts';
import {
  computeDefinitionVersion,
  verifyDefinitionVersion,
} from '../../lib/space/workflows/definition-version.ts';
import { SpaceWorkflowDefinitionVersionRepository } from '../repositories/space-workflow-definition-version-repository.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

const OLD_TEMPLATE_KEY = 'worker.coder';
const NEW_TEMPLATE_KEY = 'worker.swe';
const RELOCATED_FROM_LABEL = `${RELOCATED_FROM_LABEL_PREFIX}${NEW_TEMPLATE_KEY}`;

interface NodeRow {
  id: string;
  workflow_id: string;
  config: string | null;
}

interface WorkflowRow {
  id: string;
  space_id: string;
  post_approval: string | null;
}

interface RunRow {
  id: string;
  workflow_id: string;
  definition_version: string | null;
}

interface SlotView {
  name: string;
  agentId: string;
  rawKey: string;
  renamingKey: string | null;
}

interface NodeRecord {
  id: string;
  record: Record<string, unknown>;
  dirty: boolean;
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function renamedKeyFor(key: string, storedRelocation: string | null): string | null {
  if (key === OLD_TEMPLATE_KEY) return NEW_TEMPLATE_KEY;
  if (storedRelocation && key === NEW_TEMPLATE_KEY) return storedRelocation;
  return null;
}

function slotView(slot: Record<string, unknown>, storedRelocation: string | null): SlotView {
  const name = typeof slot.name === 'string' ? slot.name : '';
  const agentId = typeof slot.agentId === 'string' ? slot.agentId : '';
  const rawKey = typeof slot.templateKey === 'string' ? slot.templateKey : '';
  const normalizedKey = rawKey.trim();
  return {
    name: name !== '' ? name : agentId,
    agentId,
    rawKey,
    renamingKey: normalizedKey ? renamedKeyFor(normalizedKey, storedRelocation) : null,
  };
}

function collectSlotViews(
  nodes: ReadonlyArray<NodeRecord>,
  storedRelocation: string | null
): SlotView[] {
  const views: SlotView[] = [];
  for (const node of nodes) {
    if (!Array.isArray(node.record.agents)) continue;
    for (const raw of node.record.agents) {
      const slot = asRecord(raw);
      if (slot) views.push(slotView(slot, storedRelocation));
    }
  }
  return views;
}

function slotMatchesTarget(slot: SlotView, target: string, keysRenamed: boolean): boolean {
  if (slot.name === target) return true;
  if (slot.agentId !== '' && slot.agentId === target) return true;
  const key = keysRenamed && slot.renamingKey !== null ? slot.renamingKey : slot.rawKey;
  return key === target;
}

function rewriteSlots(nodes: ReadonlyArray<NodeRecord>, storedRelocation: string | null): void {
  for (const node of nodes) {
    if (!Array.isArray(node.record.agents)) continue;
    for (const raw of node.record.agents) {
      const slot = asRecord(raw);
      if (!slot || typeof slot.templateKey !== 'string') continue;
      const target = renamedKeyFor(slot.templateKey.trim(), storedRelocation);
      if (!target) continue;
      slot.templateKey = target;
      node.dirty = true;
    }
  }
}

function rewritePostApprovalTarget(
  postApproval: Record<string, unknown>,
  slots: ReadonlyArray<SlotView>,
  storedRelocation: string | null
): boolean {
  if (typeof postApproval.targetAgent !== 'string') return false;
  const target = postApproval.targetAgent;
  let replacement = renamedKeyFor(target, storedRelocation);
  if (!replacement) {
    const rawKeyMatch = slots.find((slot) => slot.renamingKey !== null && slot.rawKey === target);
    if (!rawKeyMatch || rawKeyMatch.renamingKey === null) {
      return rewriteUnchangedRouteTarget(postApproval, target, slots);
    }
    replacement = rawKeyMatch.renamingKey;
  }
  const selectedIndex = slots.findIndex((slot) => slotMatchesTarget(slot, target, false));
  if (selectedIndex < 0) return false;
  const selected = slots[selectedIndex];
  if (selected.renamingKey === null || selected.rawKey !== target) {
    return rewriteUnchangedRouteTarget(postApproval, target, slots);
  }
  if (slots.findIndex((slot) => slotMatchesTarget(slot, replacement, true)) === selectedIndex) {
    postApproval.targetAgent = replacement;
    return true;
  }
  if (
    selected.name !== '' &&
    selected.name !== target &&
    slots.findIndex((slot) => slotMatchesTarget(slot, selected.name, true)) === selectedIndex
  ) {
    postApproval.targetAgent = selected.name;
    return true;
  }
  return false;
}

function rewriteUnchangedRouteTarget(
  postApproval: Record<string, unknown>,
  target: string,
  slots: ReadonlyArray<SlotView>
): boolean {
  if (!slots.some((slot) => slot.renamingKey !== null)) return false;
  const preIndex = slots.findIndex((slot) => slotMatchesTarget(slot, target, false));
  if (preIndex < 0) return false;
  if (slots.findIndex((slot) => slotMatchesTarget(slot, target, true)) === preIndex) return false;
  const selected = slots[preIndex];
  if (
    selected.agentId !== '' &&
    slots.findIndex((slot) => slotMatchesTarget(slot, selected.agentId, true)) === preIndex
  ) {
    postApproval.targetAgent = selected.agentId;
    return true;
  }
  if (
    selected.name !== '' &&
    selected.name !== target &&
    slots.findIndex((slot) => slotMatchesTarget(slot, selected.name, true)) === preIndex
  ) {
    postApproval.targetAgent = selected.name;
    return true;
  }
  return false;
}

function rewriteNodePostApprovals(
  nodes: ReadonlyArray<NodeRecord>,
  slots: ReadonlyArray<SlotView>,
  storedRelocation: string | null
): void {
  for (const node of nodes) {
    const postApproval = asRecord(node.record.postApproval);
    if (postApproval && rewritePostApprovalTarget(postApproval, slots, storedRelocation)) {
      node.dirty = true;
    }
  }
}

function parseLabelArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

function sanitizeSpoofedRelocationLabels(db: BunDatabase, now: number): void {
  const rows = db.prepare(`SELECT key, labels FROM space_agent_templates`).all() as Array<{
    key: string;
    labels: string | null;
  }>;
  const update = db.prepare(
    `UPDATE space_agent_templates SET labels = ?, updated_at = ? WHERE key = ?`
  );
  const relocationTargetPattern = /^worker\.swe\.migrated(?:-\d+)?$/;
  for (const row of rows) {
    if (relocationTargetPattern.test(row.key)) continue;
    const labels = parseLabelArray(row.labels);
    const sanitized = labels.filter((label) => !label.startsWith(RELOCATED_FROM_LABEL_PREFIX));
    if (sanitized.length === labels.length) continue;
    update.run(JSON.stringify(sanitized), now, row.key);
  }
}

function relocateConflictingStoredTemplate(db: BunDatabase, now: number): string | null {
  if (!tableExists(db, 'space_agent_templates')) return null;
  const stored = db
    .prepare(`SELECT labels FROM space_agent_templates WHERE key = ?`)
    .get(NEW_TEMPLATE_KEY) as { labels: string | null } | undefined;
  if (!stored) return null;

  let target = `${NEW_TEMPLATE_KEY}.migrated`;
  let suffix = 2;
  while (
    db.prepare(`SELECT 1 FROM space_agent_templates WHERE key = ?`).get(target) ||
    (tableExists(db, 'space_agent_template_version_seq') &&
      db.prepare(`SELECT 1 FROM space_agent_template_version_seq WHERE key = ?`).get(target)) ||
    getLongHorizonAgentTemplate(target)
  ) {
    target = `${NEW_TEMPLATE_KEY}.migrated-${suffix++}`;
  }

  const labels = parseLabelArray(stored.labels);
  if (!labels.includes(RELOCATED_FROM_LABEL)) labels.push(RELOCATED_FROM_LABEL);
  db.prepare(
    `UPDATE space_agent_templates SET key = ?, labels = ?, updated_at = ? WHERE key = ?`
  ).run(target, JSON.stringify(labels), now, NEW_TEMPLATE_KEY);
  if (tableExists(db, 'space_agent_template_version_seq')) {
    db.prepare(`UPDATE space_agent_template_version_seq SET key = ? WHERE key = ?`).run(
      target,
      NEW_TEMPLATE_KEY
    );
  }
  return target;
}

function renameLiveWorkflowRefs(
  db: BunDatabase,
  storedRelocation: string | null,
  now: number
): void {
  const nodes = db
    .prepare(`SELECT id, workflow_id, config FROM space_workflow_nodes ORDER BY rowid ASC`)
    .all() as NodeRow[];
  const recordsByWorkflow = new Map<string, NodeRecord[]>();
  for (const node of nodes) {
    const record = asRecord(parseJson(node.config));
    if (!record) continue;
    const list = recordsByWorkflow.get(node.workflow_id) ?? [];
    list.push({ id: node.id, record, dirty: false });
    recordsByWorkflow.set(node.workflow_id, list);
  }

  const updateNode = db.prepare(
    `UPDATE space_workflow_nodes SET config = ?, updated_at = ? WHERE id = ?`
  );
  const updateWorkflow = db.prepare(
    `UPDATE space_workflows SET post_approval = ?, updated_at = ? WHERE id = ?`
  );

  for (const [workflowId, nodeRecords] of recordsByWorkflow) {
    const slots = collectSlotViews(nodeRecords, storedRelocation);
    rewriteSlots(nodeRecords, storedRelocation);
    rewriteNodePostApprovals(nodeRecords, slots, storedRelocation);
    for (const nodeRecord of nodeRecords) {
      if (!nodeRecord.dirty) continue;
      updateNode.run(JSON.stringify(nodeRecord.record), now, nodeRecord.id);
    }
    const workflowRow = db
      .prepare(`SELECT post_approval FROM space_workflows WHERE id = ?`)
      .get(workflowId) as WorkflowRow | undefined;
    const workflowPostApproval = asRecord(parseJson(workflowRow?.post_approval ?? null));
    if (
      workflowPostApproval &&
      rewritePostApprovalTarget(workflowPostApproval, slots, storedRelocation)
    ) {
      updateWorkflow.run(JSON.stringify(workflowPostApproval), now, workflowId);
    }
  }
}

function renamePinnedRunDefinitionTemplateKeys(
  db: BunDatabase,
  storedRelocation: string | null,
  now: number
): void {
  if (!tableExists(db, 'space_workflow_runs')) return;
  if (!tableExists(db, 'space_workflow_definition_versions')) return;

  const versionRepo = new SpaceWorkflowDefinitionVersionRepository(db);
  const workflowSpace = db
    .prepare(`SELECT id, space_id FROM space_workflows`)
    .all() as WorkflowRow[];
  const spaceByWorkflow = new Map(workflowSpace.map((wf) => [wf.id, wf.space_id]));

  const runs = db
    .prepare(
      `SELECT id, workflow_id, definition_version FROM space_workflow_runs
        WHERE definition_version IS NOT NULL ORDER BY rowid ASC`
    )
    .all() as RunRow[];
  if (runs.length === 0) return;

  const repointRun = db.prepare(
    `UPDATE space_workflow_runs SET definition_version = ?, updated_at = ? WHERE id = ?`
  );

  for (const run of runs) {
    const spaceId = spaceByWorkflow.get(run.workflow_id);
    const definitionVersion = run.definition_version;
    if (!spaceId || !definitionVersion) continue;
    const version = versionRepo.getVersion(run.workflow_id, definitionVersion);
    if (!version) continue;
    if (!verifyDefinitionVersion(version.payload, definitionVersion)) continue;
    const workflow = asRecord(parseJson(version.payload));
    if (!workflow || !Array.isArray(workflow.nodes)) continue;

    const nodeRecords = workflow.nodes.map((raw) => {
      const record = asRecord(raw);
      return record ? { id: '', record, dirty: false } : null;
    });
    const present = nodeRecords.filter((entry): entry is NodeRecord => entry !== null);
    const slots = collectSlotViews(present, storedRelocation);
    rewriteSlots(present, storedRelocation);
    rewriteNodePostApprovals(present, slots, storedRelocation);
    const workflowPostApproval = asRecord(workflow.postApproval);
    const workflowTargetDirty =
      workflowPostApproval !== null &&
      rewritePostApprovalTarget(workflowPostApproval, slots, storedRelocation);
    if (!present.some((entry) => entry.dirty) && !workflowTargetDirty) continue;

    const { versionHash, payload: rewrittenPayload } = computeDefinitionVersion(
      workflow as unknown as SpaceWorkflow
    );
    versionRepo.appendVersion({
      workflowId: run.workflow_id,
      spaceId,
      versionHash,
      payload: rewrittenPayload,
      source: 'backfill',
      createdAt: now,
    });
    repointRun.run(versionHash, now, run.id);
  }
}

function renameAgentRowTemplateKeys(
  db: BunDatabase,
  storedRelocation: string | null,
  now: number
): void {
  if (!tableExists(db, 'space_long_horizon_agents')) return;
  if (storedRelocation) {
    db.prepare(
      `UPDATE space_long_horizon_agents SET template_key = ?, updated_at = ? WHERE template_key = ?`
    ).run(storedRelocation, now, NEW_TEMPLATE_KEY);
  }
  db.prepare(
    `UPDATE space_long_horizon_agents SET template_key = ?, updated_at = ? WHERE template_key = ?`
  ).run(NEW_TEMPLATE_KEY, now, OLD_TEMPLATE_KEY);
}

export function runMigration239(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflow_nodes')) return;
  const now = Date.now();
  db.exec('BEGIN');
  try {
    sanitizeSpoofedRelocationLabels(db, now);
    const storedRelocation = relocateConflictingStoredTemplate(db, now);
    renameLiveWorkflowRefs(db, storedRelocation, now);
    renamePinnedRunDefinitionTemplateKeys(db, storedRelocation, now);
    renameAgentRowTemplateKeys(db, storedRelocation, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
