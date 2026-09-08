import type { SpaceWorkflow } from '@hyperneo/shared';
import { getLongHorizonAgentTemplate } from '../../lib/space/agents/long-horizon-agent-templates.ts';
import {
  computeDefinitionVersion,
  verifyDefinitionVersion,
} from '../../lib/space/workflows/definition-version.ts';
import { SpaceWorkflowDefinitionVersionRepository } from '../repositories/space-workflow-definition-version-repository.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

const OLD_TEMPLATE_KEY = 'worker.coder';
const NEW_TEMPLATE_KEY = 'worker.swe';

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

function relocatedKey(key: string): string | null {
  if (key === OLD_TEMPLATE_KEY) return NEW_TEMPLATE_KEY;
  return null;
}

function rewriteSlotTemplateKey(
  slot: Record<string, unknown>,
  storedRelocation: string | null
): boolean {
  if (typeof slot.templateKey !== 'string') return false;
  const key = slot.templateKey.trim();
  const target =
    relocatedKey(key) ?? (storedRelocation && key === NEW_TEMPLATE_KEY ? storedRelocation : null);
  if (!target) return false;
  slot.templateKey = target;
  return true;
}

function rewriteTargetAgent(
  postApproval: Record<string, unknown>,
  storedRelocation: string | null
): boolean {
  if (typeof postApproval.targetAgent !== 'string') return false;
  const target = postApproval.targetAgent.trim();
  const replacement =
    relocatedKey(target) ??
    (storedRelocation && target === NEW_TEMPLATE_KEY ? storedRelocation : null);
  if (!replacement) return false;
  postApproval.targetAgent = replacement;
  return true;
}

function rewriteRecordAgentSlots(
  record: Record<string, unknown>,
  storedRelocation: string | null
): boolean {
  let dirty = false;
  const postApproval = asRecord(record.postApproval);
  if (postApproval && rewriteTargetAgent(postApproval, storedRelocation)) dirty = true;
  if (!Array.isArray(record.agents)) return dirty;
  for (const raw of record.agents) {
    const slot = asRecord(raw);
    if (slot && rewriteSlotTemplateKey(slot, storedRelocation)) dirty = true;
  }
  return dirty;
}

function relocateConflictingStoredTemplate(db: BunDatabase, now: number): string | null {
  if (!tableExists(db, 'space_agent_templates')) return null;
  const stored = db
    .prepare(`SELECT 1 FROM space_agent_templates WHERE key = ?`)
    .get(NEW_TEMPLATE_KEY);
  if (!stored) return null;

  let target = `${NEW_TEMPLATE_KEY}.migrated`;
  let suffix = 2;
  while (
    db.prepare(`SELECT 1 FROM space_agent_templates WHERE key = ?`).get(target) ||
    getLongHorizonAgentTemplate(target)
  ) {
    target = `${NEW_TEMPLATE_KEY}.migrated-${suffix++}`;
  }

  db.prepare(`UPDATE space_agent_templates SET key = ?, updated_at = ? WHERE key = ?`).run(
    target,
    now,
    NEW_TEMPLATE_KEY
  );
  if (tableExists(db, 'space_agent_template_version_seq')) {
    db.prepare(`UPDATE OR REPLACE space_agent_template_version_seq SET key = ? WHERE key = ?`).run(
      target,
      NEW_TEMPLATE_KEY
    );
  }
  return target;
}

function renameLiveNodeTemplateKeys(
  db: BunDatabase,
  storedRelocation: string | null,
  now: number
): void {
  const nodes = db
    .prepare(`SELECT id, workflow_id, config FROM space_workflow_nodes ORDER BY rowid ASC`)
    .all() as NodeRow[];
  const updateNode = db.prepare(
    `UPDATE space_workflow_nodes SET config = ?, updated_at = ? WHERE id = ?`
  );
  for (const node of nodes) {
    const parsed = asRecord(parseJson(node.config));
    if (!parsed) continue;
    if (!rewriteRecordAgentSlots(parsed, storedRelocation)) continue;
    updateNode.run(JSON.stringify(parsed), now, node.id);
  }
}

function renameWorkflowPostApprovalTargets(
  db: BunDatabase,
  storedRelocation: string | null,
  now: number
): void {
  const workflows = db
    .prepare(`SELECT id, post_approval FROM space_workflows`)
    .all() as WorkflowRow[];
  const updateWorkflow = db.prepare(
    `UPDATE space_workflows SET post_approval = ?, updated_at = ? WHERE id = ?`
  );
  for (const workflow of workflows) {
    const parsed = asRecord(parseJson(workflow.post_approval));
    if (!parsed) continue;
    if (!rewriteTargetAgent(parsed, storedRelocation)) continue;
    updateWorkflow.run(JSON.stringify(parsed), now, workflow.id);
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

    let dirty = rewriteRecordAgentSlots(workflow, storedRelocation);
    for (const rawNode of workflow.nodes) {
      const node = asRecord(rawNode);
      if (node && rewriteRecordAgentSlots(node, storedRelocation)) dirty = true;
    }
    if (!dirty) continue;

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
    const storedRelocation = relocateConflictingStoredTemplate(db, now);
    renameLiveNodeTemplateKeys(db, storedRelocation, now);
    renameWorkflowPostApprovalTargets(db, storedRelocation, now);
    renamePinnedRunDefinitionTemplateKeys(db, storedRelocation, now);
    renameAgentRowTemplateKeys(db, storedRelocation, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
