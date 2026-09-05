import type {
  CreateSpaceAgentTemplateParams,
  SettingSource,
  SpaceAgentTemplate,
  AgentModelPoolEntry,
} from '@hyperneo/shared';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { SpaceAgentTemplateRepository } from '../repositories/space-agent-template-repository.ts';
import { SpaceWorkflowRepository } from '../repositories/space-workflow-repository.ts';
import { SpaceWorkflowDefinitionVersionRepository } from '../repositories/space-workflow-definition-version-repository.ts';
import { computeDefinitionVersion } from '../../lib/space/workflows/definition-version.ts';
import { MIGRATED_WORKER_TEMPLATE_KEY } from '../../lib/space/agents/worker-long-horizon-mapper.ts';
import {
  migratedAgentTemplateKey,
  synthesizeAgentTemplate,
  synthesizeOrphanAgentTemplate,
  type AgentTemplateSynthesisInput,
  type OrphanAgentSlotSource,
} from '../../lib/space/agents/agent-template-synthesis.ts';

interface WorkflowRow {
  id: string;
  space_id: string;
}

interface NodeRow {
  id: string;
  config: string | null;
}

interface AgentRow {
  id: string;
  space_id: string;
  handle: string | null;
  display_name: string;
  description: string | null;
  instructions: string;
  autonomy_level: number | null;
  model: string | null;
  thinking_level: string | null;
  provider: string | null;
  setting_sources: string | null;
  tool_permissions_json: string;
  model_pool: string | null;
  status: string;
  template_key: string | null;
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseJsonArray<T>(raw: string | null): T[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

function parseToolsFromPermissions(raw: string): string[] | null {
  const tools = parseJsonObject(raw)?.tools;
  if (!Array.isArray(tools)) return null;
  const filtered = tools.filter((tool): tool is string => typeof tool === 'string');
  return filtered.length > 0 ? filtered : null;
}

function agentRowToSynthesisInput(row: AgentRow): AgentTemplateSynthesisInput {
  return {
    id: row.id,
    displayName: row.display_name || row.handle || row.id,
    handle: row.handle,
    description: row.description,
    instructions: row.instructions ?? '',
    model: row.model,
    provider: row.provider,
    thinkingLevel: row.thinking_level,
    settingSources: parseJsonArray<SettingSource>(row.setting_sources),
    tools: parseToolsFromPermissions(row.tool_permissions_json),
    modelPool: parseJsonArray<AgentModelPoolEntry>(row.model_pool),
    autonomyLevel: row.autonomy_level,
  };
}

function orphanSlotSource(agentId: string, raw: Record<string, unknown>): OrphanAgentSlotSource {
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : agentId;
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model : null;
  const thinkingLevel = typeof raw.thinkingLevel === 'string' ? raw.thinkingLevel : null;
  return { name, model, thinkingLevel };
}

function isRunnableAgentRow(row: AgentRow): boolean {
  if (row.template_key === MIGRATED_WORKER_TEMPLATE_KEY) return true;
  return row.status === 'active';
}

function pinUnpinnedExecutableRuns(db: BunDatabase): Set<string> {
  const unpinnableWorkflows = new Set<string>();
  if (!tableExists(db, 'space_workflow_runs')) return unpinnableWorkflows;
  if (!tableExists(db, 'space_workflow_definition_versions')) return unpinnableWorkflows;

  const workflowRepo = new SpaceWorkflowRepository(db);
  const versionRepo = new SpaceWorkflowDefinitionVersionRepository(db);
  const pinRun = db.prepare(
    `UPDATE space_workflow_runs SET definition_version = ? WHERE id = ? AND definition_version IS NULL`
  );
  const runs = db
    .prepare(
      `SELECT r.id AS run_id, r.workflow_id FROM space_workflow_runs r
        WHERE r.definition_version IS NULL
          AND (
            NOT EXISTS (SELECT 1 FROM space_tasks t WHERE t.workflow_run_id = r.id)
            OR EXISTS (
              SELECT 1 FROM space_tasks t
               WHERE t.workflow_run_id = r.id AND t.archived_at IS NULL
            )
          )`
    )
    .all() as Array<{ run_id: string; workflow_id: string }>;

  for (const run of runs) {
    try {
      const workflow = workflowRepo.getWorkflow(run.workflow_id);
      if (!workflow) continue;
      const { versionHash, payload } = computeDefinitionVersion(workflow);
      versionRepo.appendVersion({
        workflowId: workflow.id,
        spaceId: workflow.spaceId,
        versionHash,
        payload,
        source: 'backfill',
        createdAt: Date.now(),
      });
      pinRun.run(versionHash, run.run_id);
    } catch {
      unpinnableWorkflows.add(run.workflow_id);
    }
  }
  return unpinnableWorkflows;
}

export function runMigration228(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflows')) return;
  if (!tableExists(db, 'space_workflow_nodes')) return;
  if (!tableExists(db, 'space_agent_templates')) return;

  const workflows = db
    .prepare(`SELECT id, space_id FROM space_workflows ORDER BY created_at ASC, rowid ASC`)
    .all() as WorkflowRow[];
  if (workflows.length === 0) return;

  const repo = new SpaceAgentTemplateRepository(db);
  const updateNode = db.prepare(
    `UPDATE space_workflow_nodes SET config = ?, updated_at = ? WHERE id = ?`
  );
  const now = Date.now();

  db.exec('BEGIN');
  try {
    const unpinnableWorkflows = pinUnpinnedExecutableRuns(db);
    for (const workflow of workflows) {
      if (unpinnableWorkflows.has(workflow.id)) continue;
      const nodes = db
        .prepare(
          `SELECT id, config FROM space_workflow_nodes WHERE workflow_id = ? ORDER BY rowid ASC`
        )
        .all(workflow.id) as NodeRow[];
      for (const node of nodes) {
        const parsed = parseJsonObject(node.config);
        if (!parsed || !Array.isArray(parsed.agents)) continue;
        let dirty = false;
        for (const raw of parsed.agents) {
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
          const slot = raw as Record<string, unknown>;
          const agentId = typeof slot.agentId === 'string' ? slot.agentId.trim() : '';
          if (!agentId) continue;
          if (typeof slot.templateKey === 'string' && slot.templateKey.trim()) continue;
          const key = ensureTemplateForAgentRef(db, repo, workflow.space_id, agentId, slot);
          if (!key) continue;
          slot.templateKey = key;
          dirty = true;
        }
        if (dirty) {
          updateNode.run(JSON.stringify(parsed), now, node.id);
        }
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const MAX_TEMPLATE_KEY_ATTEMPTS = 100;

function ensureTemplateForAgentRef(
  db: BunDatabase,
  repo: SpaceAgentTemplateRepository,
  spaceId: string,
  agentId: string,
  orphanSlot: Record<string, unknown>
): string | null {
  const agent = findAgentRowForSynthesis(db, agentId);
  if (agent && agent.space_id !== spaceId) return null;
  if (agent && !isRunnableAgentRow(agent)) return null;

  const params = agent
    ? synthesizeAgentTemplate(agentRowToSynthesisInput(agent))
    : synthesizeOrphanAgentTemplate(agentId, orphanSlotSource(agentId, orphanSlot));
  const baseKey = migratedAgentTemplateKey(agentId);

  const existing = repo.getByKey(baseKey);
  if (!existing) {
    repo.create({ ...params, key: baseKey });
    return baseKey;
  }
  if (matchesSynthesis(existing, params)) return baseKey;

  for (let attempt = 0; attempt < MAX_TEMPLATE_KEY_ATTEMPTS; attempt++) {
    const key = attempt === 0 ? `${baseKey}.m228` : `${baseKey}.m228-${attempt + 1}`;
    const occupied = repo.getByKey(key);
    if (!occupied) {
      repo.create({ ...params, key });
      return key;
    }
    if (matchesSynthesis(occupied, params)) return key;
  }
  throw new Error(
    `Could not find an available migrated template key for agent "${agentId}" after ${MAX_TEMPLATE_KEY_ATTEMPTS} attempts`
  );
}

function matchesSynthesis(
  existing: SpaceAgentTemplate,
  params: CreateSpaceAgentTemplateParams
): boolean {
  const normalizePool = (pool: CreateSpaceAgentTemplateParams['modelPool']) =>
    pool && pool.length > 0 ? JSON.stringify(pool) : null;
  const normalizeTools = (tools: CreateSpaceAgentTemplateParams['tools']) =>
    tools && tools.length > 0 ? JSON.stringify([...tools].sort()) : null;
  return (
    existing.handle === params.handle &&
    existing.displayName === params.displayName &&
    existing.description === (params.description ?? '') &&
    existing.instructions === (params.instructions ?? '') &&
    existing.suggestedAutonomyLevel === (params.suggestedAutonomyLevel ?? 2) &&
    existing.model === (params.model ?? null) &&
    existing.provider === (params.provider ?? null) &&
    existing.thinkingLevel === (params.thinkingLevel ?? null) &&
    JSON.stringify(existing.settingSources ?? null) ===
      JSON.stringify(params.settingSources ?? null) &&
    normalizePool(existing.modelPool) === normalizePool(params.modelPool) &&
    normalizeTools(existing.tools) === normalizeTools(params.tools)
  );
}

function findAgentRowForSynthesis(db: BunDatabase, agentId: string): AgentRow | null {
  if (!tableExists(db, 'space_long_horizon_agents')) return null;
  const row = db
    .prepare(
      `SELECT id, space_id, handle, display_name, description, instructions, autonomy_level,
              model, thinking_level, provider, setting_sources, tool_permissions_json,
              model_pool, status, template_key
         FROM space_long_horizon_agents
        WHERE id = ?`
    )
    .get(agentId) as AgentRow | undefined;
  return row ?? null;
}
