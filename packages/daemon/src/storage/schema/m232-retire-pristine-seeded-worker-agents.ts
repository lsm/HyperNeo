import type { SpaceLongHorizonAgent } from '@hyperneo/shared';
import { computeAgentTemplateHash } from '../../lib/space/agents/agent-template-hash.ts';
import { retireRemovedPresetAgents } from '../../lib/space/agents/seed-agents.ts';
import { SpaceLongHorizonAgentRepository } from '../repositories/space-long-horizon-agent-repository.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { KNOWN_PRESET_NAMES } from './m106-backfill-agent-templates.ts';

interface LegacyFingerprintRow {
  id: string;
  name: string;
  description: string | null;
  tools: string | null;
  custom_prompt: string | null;
  template_name: string | null;
  template_hash: string | null;
}

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

function isPristineWorker(
  agent: SpaceLongHorizonAgent,
  fingerprints: ReadonlyMap<string, LegacyFingerprintRow>
): boolean {
  const fingerprint = fingerprints.get(agent.id);
  const canonicalName = KNOWN_PRESET_NAMES.find(
    (name) => name.toLowerCase() === fingerprint?.name.trim().toLowerCase()
  );
  if (
    agent.templateKey !== 'migration.legacy_space_agent' ||
    !fingerprint ||
    !canonicalName ||
    fingerprint.template_name !== canonicalName ||
    !fingerprint.template_hash
  ) {
    return false;
  }
  const rowHash = computeAgentTemplateHash({
    name: canonicalName,
    description: fingerprint.description ?? '',
    tools: parseTools(fingerprint.tools),
    customPrompt: fingerprint.custom_prompt ?? '',
  });
  const agentTools = Array.isArray(agent.toolPermissions.tools)
    ? agent.toolPermissions.tools.filter((tool): tool is string => typeof tool === 'string')
    : [];
  const agentHash = computeAgentTemplateHash({
    name: agent.displayName,
    description: agent.description ?? '',
    tools: agentTools,
    customPrompt: agent.instructions,
  });
  return rowHash === fingerprint.template_hash && agentHash === fingerprint.template_hash;
}

function referencedAgentIds(db: BunDatabase): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT json_extract(slot.value, '$.agentId') AS agent_id
         FROM space_workflow_nodes nodes, json_each(nodes.config, '$.agents') slot
        WHERE json_valid(nodes.config)
          AND json_type(slot.value, '$.agentId') = 'text'
          AND json_extract(slot.value, '$.agentId') != ''`
    )
    .all() as Array<{ agent_id: string }>;
  return new Set(rows.map((row) => row.agent_id));
}

export function runMigration232(db: BunDatabase): void {
  if (
    !tableExists(db, 'space_agents') ||
    !tableExists(db, 'space_long_horizon_agents') ||
    !tableExists(db, 'space_workflow_nodes')
  ) {
    return;
  }
  const fingerprints = new Map(
    (
      db
        .prepare(
          `SELECT id, name, description, tools, custom_prompt, template_name, template_hash
             FROM space_agents`
        )
        .all() as LegacyFingerprintRow[]
    ).map((row) => [row.id, row])
  );
  const referenced = referencedAgentIds(db);
  const agentRepo = new SpaceLongHorizonAgentRepository(db);
  const spaces = db.prepare(`SELECT id FROM spaces`).all() as Array<{ id: string }>;
  for (const space of spaces) {
    retireRemovedPresetAgents(space.id, {
      agentRepo,
      referencedAgentIds: referenced,
      isPristineRetiredRow: (agent) => isPristineWorker(agent, fingerprints),
    });
  }
}
