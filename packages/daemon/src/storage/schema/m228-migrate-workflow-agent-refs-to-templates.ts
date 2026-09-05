import type { SettingSource, ThinkingLevel, WorkerAgentModelPoolEntry } from '@hyperneo/shared';
import { getLongHorizonAgentTemplates } from '../../lib/space/agents/long-horizon-agent-templates.ts';
import {
  allocateMigratedTemplateKey,
  synthesizeOrphanWorkflowAgentTemplate,
  synthesizeWorkflowAgentTemplate,
  type WorkflowAgentTemplateSynthesisSource,
} from '../../lib/space/agents/workflow-agent-template-synthesis.ts';
import { SpaceAgentTemplateRepository } from '../repositories/space-agent-template-repository.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

interface AgentRow {
  id: string;
  handle: string | null;
  display_name: string | null;
  instructions: string | null;
  autonomy_level: number | null;
  model: string | null;
  thinking_level: ThinkingLevel | null;
  provider: string | null;
  setting_sources: string | null;
  tool_permissions_json: string | null;
  model_pool: string | null;
  description: string | null;
}

interface NodeRow {
  id: string;
  config: string | null;
}

interface SlotShape {
  agentId?: string | null;
  templateKey?: string | null;
  name?: string | null;
  [field: string]: unknown;
}

export function runMigration228(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflow_nodes')) return;
  if (!tableExists(db, 'space_agent_templates')) return;
  if (!tableExists(db, 'space_long_horizon_agents')) return;

  const templateRepo = new SpaceAgentTemplateRepository(db);
  const claimed = new Set<string>(templateRepo.list().map((template) => template.key));
  for (const template of getLongHorizonAgentTemplates()) claimed.add(template.key);

  const agentsById = new Map<string, AgentRow>(
    (
      db
        .prepare(
          `SELECT id, handle, display_name, instructions, autonomy_level, model,
                thinking_level, provider, setting_sources, tool_permissions_json,
                model_pool, description
           FROM space_long_horizon_agents`
        )
        .all() as AgentRow[]
    ).map((row) => [row.id, row])
  );
  const templateKeysByAgentId = new Map<string, string>();

  const updateNode = db.prepare(
    `UPDATE space_workflow_nodes SET config = ?, updated_at = ? WHERE id = ?`
  );
  const clearExecutionAgentId = tableExists(db, 'node_executions')
    ? db.prepare(
        `UPDATE node_executions SET agent_id = NULL
          WHERE workflow_node_id = ? AND agent_name = ? AND agent_id = ?`
      )
    : null;

  const nodeRows = db
    .prepare(`SELECT id, config FROM space_workflow_nodes ORDER BY rowid ASC`)
    .all() as NodeRow[];

  for (const nodeRow of nodeRows) {
    const config = parseRecord(nodeRow.config);
    const slots = Array.isArray(config?.agents) ? (config.agents as SlotShape[]) : null;
    if (!slots || slots.length === 0) continue;

    let changed = false;
    for (const slot of slots) {
      const agentId = typeof slot.agentId === 'string' ? slot.agentId : '';
      if (!agentId.trim()) continue;
      if (typeof slot.templateKey === 'string' && slot.templateKey.trim()) continue;

      const agentRow = agentsById.get(agentId);
      const seed = agentRow
        ? agentRow.handle || agentRow.display_name || agentRow.id
        : slot.name || agentId;
      let key = templateKeysByAgentId.get(agentId);
      if (!key) {
        key = allocateMigratedTemplateKey(seed, agentId, claimed);
        claimed.add(key);
        templateKeysByAgentId.set(agentId, key);
        templateRepo.create(
          agentRow
            ? synthesizeWorkflowAgentTemplate(rowToSynthesisSource(agentRow), key)
            : synthesizeOrphanWorkflowAgentTemplate(
                { agentId, slotName: typeof slot.name === 'string' ? slot.name : '' },
                key
              )
        );
      }

      slot.templateKey = key;
      changed = true;

      if (clearExecutionAgentId) {
        clearExecutionAgentId.run(
          nodeRow.id,
          typeof slot.name === 'string' ? slot.name : '',
          agentId
        );
      }
    }

    if (changed) {
      updateNode.run(JSON.stringify(config), Date.now(), nodeRow.id);
    }
  }
}

function rowToSynthesisSource(row: AgentRow): WorkflowAgentTemplateSynthesisSource {
  const permissions = parseRecord(row.tool_permissions_json);
  const tools = Array.isArray(permissions?.tools)
    ? permissions.tools.filter((tool): tool is string => typeof tool === 'string')
    : null;
  return {
    id: row.id,
    handle: row.handle ?? '',
    displayName: row.display_name ?? row.id,
    description: row.description,
    instructions: row.instructions,
    autonomyLevel:
      (row.autonomy_level as WorkflowAgentTemplateSynthesisSource['autonomyLevel']) ?? null,
    model: row.model,
    provider: row.provider,
    thinkingLevel: row.thinking_level ?? null,
    settingSources: parseJsonArray<SettingSource>(row.setting_sources),
    tools,
    modelPool: parseJsonArray<WorkerAgentModelPoolEntry>(row.model_pool),
  };
}

function parseRecord(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
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

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
}
