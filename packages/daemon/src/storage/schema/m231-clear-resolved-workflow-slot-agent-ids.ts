import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { SpaceAgentTemplateRepository } from '../repositories/space-agent-template-repository.ts';
import { SpaceWorkflowDefinitionVersionRepository } from '../repositories/space-workflow-definition-version-repository.ts';
import { computeDefinitionVersion } from '../../lib/space/workflows/definition-version.ts';
import type { SpaceWorkflow } from '@hyperneo/shared';
import { getLongHorizonAgentTemplates } from '../../lib/space/agents/long-horizon-agent-templates.ts';
import { ensureTemplateForAgentRef } from './m228-migrate-workflow-agent-template-refs.ts';

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

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  return asRecord(parseJson(raw));
}

export function runMigration231(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflow_nodes')) return;
  if (!tableExists(db, 'space_agent_templates')) return;

  const templateRepo = new SpaceAgentTemplateRepository(db);
  const builtInKeys = new Set(getLongHorizonAgentTemplates().map((t) => t.key));
  const resolvable = (key: string): boolean => !!templateRepo.getByKey(key) || builtInKeys.has(key);
  const now = Date.now();

  db.exec('BEGIN');
  try {
    clearLiveNodeAgentIds(db, resolvable, now);
    migratePinnedRunDefinitions(db, templateRepo, resolvable, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function clearLiveNodeAgentIds(
  db: BunDatabase,
  resolvable: (key: string) => boolean,
  now: number
): void {
  const workflows = db
    .prepare(`SELECT id, space_id, post_approval FROM space_workflows ORDER BY rowid ASC`)
    .all() as WorkflowRow[];
  const workflowById = new Map(workflows.map((wf) => [wf.id, wf]));

  const nodes = db
    .prepare(`SELECT id, workflow_id, config FROM space_workflow_nodes ORDER BY rowid ASC`)
    .all() as NodeRow[];
  const updateNode = db.prepare(
    `UPDATE space_workflow_nodes SET config = ?, updated_at = ? WHERE id = ?`
  );
  const updateWorkflowPostApproval = db.prepare(
    `UPDATE space_workflows SET post_approval = ?, updated_at = ? WHERE id = ?`
  );

  const parsedById = new Map<string, Record<string, unknown>>();
  const dirtyNodeIds = new Set<string>();
  const dirtyWorkflowIds = new Set<string>();
  const clearedByWorkflow = new Map<string, Map<string, string>>();
  const seenAgentIdByWorkflow = new Map<string, Set<string>>();

  for (const node of nodes) {
    const parsed = parseJsonObject(node.config);
    if (!parsed || !Array.isArray(parsed.agents)) continue;
    parsedById.set(node.id, parsed);
    let dirty = false;
    for (const raw of parsed.agents) {
      const slot = asRecord(raw);
      if (!slot) continue;
      const agentId = typeof slot.agentId === 'string' ? slot.agentId.trim() : '';
      if (!agentId) continue;
      const key = typeof slot.templateKey === 'string' ? slot.templateKey.trim() : '';
      const willClear = !!key && resolvable(key);
      const seen = seenAgentIdByWorkflow.get(node.workflow_id) ?? new Set<string>();
      if (willClear) {
        if (typeof slot.name !== 'string' || !slot.name.trim()) {
          slot.name = agentId;
        }
        const clearedNamesByAgentId =
          clearedByWorkflow.get(node.workflow_id) ?? new Map<string, string>();
        if (!seen.has(agentId) && typeof slot.name === 'string') {
          clearedNamesByAgentId.set(agentId, slot.name);
        }
        clearedByWorkflow.set(node.workflow_id, clearedNamesByAgentId);
        slot.agentId = '';
        dirty = true;
      }
      seen.add(agentId);
      seenAgentIdByWorkflow.set(node.workflow_id, seen);
    }
    if (!dirty) continue;
    dirtyNodeIds.add(node.id);
    dirtyWorkflowIds.add(node.workflow_id);
  }

  for (const node of nodes) {
    if (!dirtyWorkflowIds.has(node.workflow_id)) continue;
    const parsed = parsedById.get(node.id);
    if (!parsed) continue;
    const clearedNamesByAgentId =
      clearedByWorkflow.get(node.workflow_id) ?? new Map<string, string>();
    const before = dirtyNodeIds.has(node.id) ? null : JSON.stringify(parsed);
    const nodePostApproval = asRecord(parsed.postApproval);
    if (nodePostApproval) {
      rewriteTargetAgent(nodePostApproval, clearedNamesByAgentId);
    }
    if (before !== null && JSON.stringify(parsed) === before) continue;
    updateNode.run(JSON.stringify(parsed), now, node.id);
  }

  for (const workflowId of dirtyWorkflowIds) {
    const workflow = workflowById.get(workflowId);
    if (!workflow) continue;
    const workflowPostApproval = parseJsonObject(workflow.post_approval ?? null);
    if (!workflowPostApproval) continue;
    const before = JSON.stringify(workflowPostApproval);
    rewriteTargetAgent(
      workflowPostApproval,
      clearedByWorkflow.get(workflowId) ?? new Map<string, string>()
    );
    if (JSON.stringify(workflowPostApproval) !== before) {
      updateWorkflowPostApproval.run(JSON.stringify(workflowPostApproval), now, workflow.id);
    }
  }
}

function rewriteTargetAgent(
  postApproval: Record<string, unknown>,
  clearedNamesByAgentId: Map<string, string>
): void {
  const target = postApproval.targetAgent;
  if (typeof target !== 'string') return;
  const replacement = clearedNamesByAgentId.get(target);
  if (replacement) postApproval.targetAgent = replacement;
}

function migratePinnedRunDefinitions(
  db: BunDatabase,
  templateRepo: SpaceAgentTemplateRepository,
  resolvable: (key: string) => boolean,
  now: number
): void {
  if (!tableExists(db, 'space_workflow_runs')) return;
  if (!tableExists(db, 'space_workflow_definition_versions')) return;

  const versionRepo = new SpaceWorkflowDefinitionVersionRepository(db);
  const workflowSpace = db.prepare(`SELECT id, space_id FROM space_workflows`).all() as Array<{
    id: string;
    space_id: string;
  }>;
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
    const payload = parseJson(version.payload);
    const workflow = asRecord(payload);
    if (!workflow || !Array.isArray(workflow.nodes)) continue;

    const seenAgentIds = new Set<string>();
    const templateKeyByAgentId = new Map<string, string>();
    const namesByAgentId = new Map<string, string>();
    let dirty = false;
    for (const rawNode of workflow.nodes) {
      const node = asRecord(rawNode);
      if (!node || !Array.isArray(node.agents)) continue;
      for (const rawSlot of node.agents) {
        const slot = asRecord(rawSlot);
        if (!slot) continue;
        const agentId = typeof slot.agentId === 'string' ? slot.agentId.trim() : '';
        if (!agentId) continue;
        const existingKey = typeof slot.templateKey === 'string' ? slot.templateKey.trim() : '';
        const key = existingKey
          ? resolvable(existingKey)
            ? existingKey
            : null
          : (templateKeyByAgentId.get(agentId) ??
            ensureTemplateForAgentRef(db, templateRepo, spaceId, agentId, slot));
        if (key) {
          if (typeof slot.name !== 'string' || !slot.name.trim()) {
            slot.name = agentId;
          }
          if (!seenAgentIds.has(agentId) && typeof slot.name === 'string') {
            namesByAgentId.set(agentId, slot.name);
          }
          if (!existingKey) templateKeyByAgentId.set(agentId, key);
          slot.templateKey = key;
          slot.agentId = '';
          dirty = true;
        }
        seenAgentIds.add(agentId);
      }
    }
    if (!dirty) continue;
    for (const rawNode of workflow.nodes) {
      const nodePostApproval = asRecord(asRecord(rawNode)?.postApproval);
      if (nodePostApproval) rewriteTargetAgent(nodePostApproval, namesByAgentId);
    }
    const workflowPostApproval = asRecord(workflow.postApproval);
    if (workflowPostApproval) rewriteTargetAgent(workflowPostApproval, namesByAgentId);

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
