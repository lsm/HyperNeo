import type { SpaceLongHorizonAgent } from '@hyperneo/shared';
import { computeAgentTemplateHash } from '../../lib/space/agents/agent-template-hash.ts';
import { retireRemovedPresetAgents } from '../../lib/space/agents/seed-agents.ts';
import { MIGRATED_WORKER_TEMPLATE_KEY } from '../../lib/space/agents/worker-long-horizon-mapper.ts';
import { SpaceLongHorizonAgentRepository } from '../repositories/space-long-horizon-agent-repository.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

interface PresetSnapshot {
  name: string;
  handle: string;
  tools: string[];
  hash: string;
}

const M233_PRESET_SNAPSHOTS: readonly PresetSnapshot[] = [
  {
    name: 'Coder',
    handle: 'coder',
    tools: [],
    hash: 'd0e0e44251c18e81a2ba89b0544c8215d736fe77f3719f570e85fe9734859c50',
  },
  {
    name: 'General',
    handle: 'general',
    tools: [],
    hash: 'e1e6f111c1e9eaba51a786bcf680e47e2687af0e54536a2de06766d478a13c8b',
  },
  {
    name: 'Planner',
    handle: 'planner',
    tools: [],
    hash: '527481864d7b8025f454dd74df7033e8c8a1e7ab66b8d826bb029883cd0c0c27',
  },
  {
    name: 'Research',
    handle: 'research',
    tools: [],
    hash: 'be40a0bd7539831052715ae56c10544dc74a00c6819bf42228824106bbaf0592',
  },
  {
    name: 'Reviewer',
    handle: 'reviewer',
    tools: [
      'Read',
      'Bash(gh pr view:*)',
      'Bash(gh pr diff:*)',
      'Bash(gh pr checks:*)',
      'Bash(gh api graphql:*)',
      'Bash(gh api repos:*)',
      'Bash(jq:*)',
      'Bash(mktemp:*)',
      'Bash(echo:*)',
      'Bash(cat:*)',
      'Bash(test:*)',
      'Bash(head:*)',
      'Bash(tr:*)',
      'Bash(base64:*)',
      'Bash(exit:*)',
      'Grep',
      'Glob',
      'WebFetch',
      'WebSearch',
      'Skill',
      'ToolSearch',
      'Task',
      'TaskOutput',
      'TaskStop',
      'CronCreate',
      'CronDelete',
      'CronList',
    ],
    hash: '30bfb248040aab69e0fff658d2aa2c249f1557b31a2e6391cb2d111456e8f1fc',
  },
  {
    name: 'QA',
    handle: 'qa',
    tools: ['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch'],
    hash: '105e25ecc4e8b2aede13c17a4bdd23dc726262d7291d20ba7a94f206cd9f115f',
  },
];

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
  liveAgentIds: ReadonlySet<string>
): boolean {
  if (agent.templateKey !== MIGRATED_WORKER_TEMPLATE_KEY) return false;
  if (liveAgentIds.has(agent.id)) return false;
  const snapshot = M233_PRESET_SNAPSHOTS.find((entry) => entry.name === agent.displayName);
  if (!snapshot) return false;
  if (!isMigratedHandle(agent.handle, snapshot.handle, agent.id)) return false;
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
  const rawTools: unknown = permissions.tools;
  if (rawTools === undefined) {
    if (snapshot.tools.length > 0) return false;
  } else if (
    !Array.isArray(rawTools) ||
    rawTools.length !== snapshot.tools.length ||
    rawTools.some((tool, index) => tool !== snapshot.tools[index])
  ) {
    return false;
  }
  return (
    computeAgentTemplateHash({
      name: snapshot.name,
      description: agent.description ?? '',
      tools: snapshot.tools,
      customPrompt: agent.instructions,
    }) === snapshot.hash
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
       JOIN (
                SELECT DISTINCT workflow_id, definition_version
                  FROM space_workflow_runs
                 WHERE definition_version IS NOT NULL
            ) pinned
         ON pinned.workflow_id = versions.workflow_id
        AND pinned.definition_version = versions.version_hash
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
      WHERE slot.type = 'object'
        AND json_type(slot.value, '$.agentId') = 'text'
        AND json_extract(slot.value, '$.agentId') != ''`,
    'agent_id',
    referenced
  );
  return referenced;
}

export function runMigration233(db: BunDatabase): void {
  if (!tableExists(db, 'space_long_horizon_agents') || !tableExists(db, 'space_workflow_nodes')) {
    return;
  }
  const liveAgentIds = agentsWithLiveState(db);
  const referenced = referencedAgentIds(db);
  const agentRepo = new SpaceLongHorizonAgentRepository(db);
  const spaces = db.prepare(`SELECT id FROM spaces`).all() as Array<{ id: string }>;
  for (const space of spaces) {
    retireRemovedPresetAgents(space.id, {
      agentRepo,
      referencedAgentIds: referenced,
      isPristineRetiredRow: (agent) => isPristineWorker(agent, liveAgentIds),
    });
  }
}
