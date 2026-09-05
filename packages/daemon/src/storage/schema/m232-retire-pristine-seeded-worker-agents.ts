import type { SpaceLongHorizonAgent } from '@hyperneo/shared';
import { computeAgentTemplateHash } from '../../lib/space/agents/agent-template-hash.ts';
import {
  getPresetAgentTemplates,
  retireRemovedPresetAgents,
  type PresetAgentTemplate,
} from '../../lib/space/agents/seed-agents.ts';
import { MIGRATED_WORKER_TEMPLATE_KEY } from '../../lib/space/agents/worker-long-horizon-mapper.ts';
import { SpaceLongHorizonAgentRepository } from '../repositories/space-long-horizon-agent-repository.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

interface LegacyWorkerRow {
  id: string;
  description: string | null;
  tools: string | null;
  custom_prompt: string | null;
  template_name: string | null;
}

const PRESETS_BY_TEMPLATE_NAME = new Map(
  getPresetAgentTemplates().map((preset) => [preset.name, preset])
);

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
}

function parseTools(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((tool): tool is string => typeof tool === 'string')
      : [];
  } catch {
    return [];
  }
}

function collectAgentIds(db: BunDatabase, sql: string, column: string, ids: Set<string>): void {
  for (const row of db.prepare(sql).all() as Array<Record<string, unknown>>) {
    const value = row[column];
    if (typeof value === 'string' && value) ids.add(value);
  }
}

function agentsWithLiveState(db: BunDatabase): Set<string> {
  const ids = new Set<string>();
  if (tableExists(db, 'space_agent_inbox_messages')) {
    collectAgentIds(
      db,
      `SELECT DISTINCT target_agent_id FROM space_agent_inbox_messages WHERE status = 'pending'`,
      'target_agent_id',
      ids
    );
  }
  if (tableExists(db, 'space_agent_inactivity_config')) {
    collectAgentIds(
      db,
      `SELECT DISTINCT agent_id FROM space_agent_inactivity_config`,
      'agent_id',
      ids
    );
  }
  if (tableExists(db, 'space_agent_inactivity_claims')) {
    collectAgentIds(
      db,
      `SELECT DISTINCT agent_id FROM space_agent_inactivity_claims`,
      'agent_id',
      ids
    );
  }
  return ids;
}

function isUntouchedMirror(agent: SpaceLongHorizonAgent, preset: PresetAgentTemplate): boolean {
  return (
    (agent.handle === preset.handle || agent.handle === `${preset.handle}-${agent.id}`) &&
    agent.status === 'active' &&
    agent.sessionId === null &&
    agent.autonomyLevel === null &&
    agent.model === null &&
    agent.thinkingLevel === null &&
    agent.provider === null &&
    agent.settingSources === null &&
    (agent.modelPool == null || agent.modelPool.length === 0)
  );
}

function isPristineWorker(
  agent: SpaceLongHorizonAgent,
  legacyRows: ReadonlyMap<string, LegacyWorkerRow>,
  liveAgentIds: ReadonlySet<string>
): boolean {
  if (agent.templateKey !== MIGRATED_WORKER_TEMPLATE_KEY) return false;
  if (liveAgentIds.has(agent.id)) return false;
  const legacy = legacyRows.get(agent.id);
  const preset = PRESETS_BY_TEMPLATE_NAME.get(legacy?.template_name ?? '');
  if (!legacy || !preset || !isUntouchedMirror(agent, preset)) return false;
  const presetHash = computeAgentTemplateHash(preset);
  const legacyHash = computeAgentTemplateHash({
    name: preset.name,
    description: legacy.description ?? '',
    tools: parseTools(legacy.tools),
    customPrompt: legacy.custom_prompt ?? '',
  });
  if (legacyHash !== presetHash) return false;
  const tools = Array.isArray(agent.toolPermissions.tools)
    ? agent.toolPermissions.tools.filter((tool): tool is string => typeof tool === 'string')
    : [];
  return (
    computeAgentTemplateHash({
      name: agent.displayName,
      description: agent.description ?? '',
      tools,
      customPrompt: agent.instructions,
    }) === presetHash
  );
}

export function runMigration232(db: BunDatabase): void {
  if (
    !tableExists(db, 'space_agents') ||
    !tableExists(db, 'space_long_horizon_agents') ||
    !tableExists(db, 'space_workflow_nodes')
  ) {
    return;
  }
  const legacyRows = new Map(
    (
      db
        .prepare(`SELECT id, description, tools, custom_prompt, template_name FROM space_agents`)
        .all() as LegacyWorkerRow[]
    ).map((row) => [row.id, row])
  );
  const referenced = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT json_extract(slot.value, '$.agentId') AS agent_id
             FROM space_workflow_nodes nodes, json_each(nodes.config, '$.agents') slot
            WHERE json_valid(nodes.config)
              AND json_type(slot.value, '$.agentId') = 'text'
              AND json_extract(slot.value, '$.agentId') != ''`
        )
        .all() as Array<{ agent_id: string }>
    ).map((row) => row.agent_id)
  );
  const liveState = agentsWithLiveState(db);
  const agentRepo = new SpaceLongHorizonAgentRepository(db);
  const spaces = db.prepare(`SELECT id FROM spaces`).all() as Array<{ id: string }>;
  for (const space of spaces) {
    retireRemovedPresetAgents(space.id, {
      agentRepo,
      referencedAgentIds: referenced,
      isPristineRetiredRow: (agent) => isPristineWorker(agent, legacyRows, liveState),
    });
  }
}
