import type { SpaceLongHorizonAgent } from '@hyperneo/shared';
import { computeAgentTemplateHash } from '../../lib/space/agents/agent-template-hash.ts';
import {
  getPresetAgentTemplates,
  retireRemovedPresetAgents,
} from '../../lib/space/agents/seed-agents.ts';
import { MIGRATED_WORKER_TEMPLATE_KEY } from '../../lib/space/agents/worker-long-horizon-mapper.ts';
import { SpaceLongHorizonAgentRepository } from '../repositories/space-long-horizon-agent-repository.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

interface LegacyWorkerRow {
  id: string;
  template_name: string | null;
}

const PRESET_HASHES = new Map(
  getPresetAgentTemplates().map((preset) => [preset.name, computeAgentTemplateHash(preset)])
);

const PRESETS_BY_TEMPLATE_NAME = new Map(
  getPresetAgentTemplates().map((preset) => [preset.name, preset])
);

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
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

function isMigratedHandle(handle: string, presetHandle: string, agentId: string): boolean {
  const suffix = `-${agentId}`;
  let base = handle;
  while (base.endsWith(suffix)) base = base.slice(0, base.length - suffix.length);
  return base === presetHandle;
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
  if (!legacy || !preset) return false;
  if (agent.displayName !== preset.name) return false;
  if (!isMigratedHandle(agent.handle, preset.handle, agent.id)) return false;
  if (
    agent.status !== 'active' ||
    agent.sessionId !== null ||
    agent.autonomyLevel !== null ||
    agent.model !== null ||
    agent.thinkingLevel !== null ||
    agent.provider !== null ||
    agent.settingSources !== null ||
    (agent.modelPool != null && agent.modelPool.length > 0)
  ) {
    return false;
  }
  const permissions = (agent.toolPermissions ?? {}) as Record<string, unknown>;
  if (Object.keys(permissions).some((key) => key !== 'tools')) return false;
  const tools = Array.isArray(permissions.tools)
    ? permissions.tools.filter((tool): tool is string => typeof tool === 'string')
    : [];
  return (
    computeAgentTemplateHash({
      name: preset.name,
      description: agent.description ?? '',
      tools,
      customPrompt: agent.instructions,
    }) === PRESET_HASHES.get(preset.name)
  );
}

function referencedAgentIds(db: BunDatabase): Set<string> {
  const referenced = new Set<string>();
  collectAgentIds(
    db,
    `SELECT DISTINCT json_extract(slot.value, '$.agentId') AS agent_id
       FROM space_workflow_nodes nodes,
            json_each(
              CASE WHEN json_valid(nodes.config) THEN nodes.config END,
              '$.agents'
            ) slot
      WHERE slot.type = 'object'
        AND json_type(slot.value, '$.agentId') = 'text'
        AND json_extract(slot.value, '$.agentId') != ''`,
    'agent_id',
    referenced
  );
  if (
    !tableExists(db, 'space_workflow_definition_versions') ||
    !tableExists(db, 'space_workflow_runs')
  ) {
    return referenced;
  }
  collectAgentIds(
    db,
    `SELECT DISTINCT json_extract(slot.value, '$.agentId') AS agent_id
       FROM space_workflow_definition_versions versions
       JOIN space_workflow_runs runs
         ON runs.workflow_id = versions.workflow_id
        AND runs.definition_version = versions.version_hash
       JOIN json_each(
              CASE WHEN json_valid(versions.payload) THEN versions.payload END,
              '$.nodes'
            ) node
       JOIN json_each(
              CASE
                WHEN json_valid(node.value) AND json_type(node.value) = 'object'
                THEN node.value
              END,
              '$.agents'
            ) slot
      WHERE runs.status IN ('pending', 'in_progress', 'blocked')
        AND slot.type = 'object'
        AND json_type(slot.value, '$.agentId') = 'text'
        AND json_extract(slot.value, '$.agentId') != ''`,
    'agent_id',
    referenced
  );
  return referenced;
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
    (db.prepare(`SELECT id, template_name FROM space_agents`).all() as LegacyWorkerRow[]).map(
      (row) => [row.id, row]
    )
  );
  const liveAgentIds = agentsWithLiveState(db);
  const referenced = referencedAgentIds(db);
  const agentRepo = new SpaceLongHorizonAgentRepository(db);
  const spaces = db.prepare(`SELECT id FROM spaces`).all() as Array<{ id: string }>;
  for (const space of spaces) {
    retireRemovedPresetAgents(space.id, {
      agentRepo,
      referencedAgentIds: referenced,
      isPristineRetiredRow: (agent) => isPristineWorker(agent, legacyRows, liveAgentIds),
    });
  }
}
