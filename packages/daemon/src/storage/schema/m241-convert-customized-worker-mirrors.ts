import type {
  CreateSpaceAgentTemplateParams,
  SpaceAgentTemplate,
  SpaceLongHorizonAgent,
  SpaceWorkflow,
} from '@hyperneo/shared';
import {
  MIGRATED_AGENT_TEMPLATE_KEY_PREFIX,
  synthesizeWorkerCustomTemplate,
  workerCustomTemplateKey,
} from '../../lib/space/agents/agent-template-synthesis.ts';
import { getLongHorizonAgentTemplates } from '../../lib/space/agents/long-horizon-agent-templates.ts';
import { MIGRATED_WORKER_TEMPLATE_KEY } from '../../lib/space/agents/worker-long-horizon-mapper.ts';
import {
  computeDefinitionVersion,
  verifyDefinitionVersion,
} from '../../lib/space/workflows/definition-version.ts';
import { SpaceAgentTemplateRepository } from '../repositories/space-agent-template-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../repositories/space-long-horizon-agent-repository.ts';
import { SpaceWorkflowDefinitionVersionRepository } from '../repositories/space-workflow-definition-version-repository.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { matchesSynthesis } from './m228-migrate-workflow-agent-template-refs.ts';
import {
  agentsWithLiveState,
  isPristineWorkerContent,
  referencedAgentIds,
} from './m233-retire-pristine-seeded-worker-agents.ts';

const TASK_AGENT_TARGET = 'task-agent';
const MAX_TEMPLATE_KEY_ATTEMPTS = 100;

interface WorkflowRow {
  id: string;
  space_id: string;
  post_approval: string | null;
}

interface NodeRow {
  id: string;
  workflow_id: string;
  name: string;
  config: string | null;
}

interface RunRow {
  id: string;
  workflow_id: string;
  definition_version: string | null;
}

interface SlotOccurrence {
  slot: Record<string, unknown>;
  agentId: string;
  rawName: string;
  effectiveName: string;
  node?: Record<string, unknown>;
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return asRecord(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function addPostApprovalTarget(targets: Set<string>, raw: unknown): void {
  if (typeof raw !== 'string') return;
  const value = raw.trim();
  if (value && value !== TASK_AGENT_TARGET) targets.add(value);
}

function effectiveSlotName(rawName: unknown, agentId: string): string {
  if (typeof rawName === 'string' && rawName.trim()) return rawName;
  return agentId;
}

function resolveMigratedAgentIdentity(templateKey: string): string {
  const prefix = `${MIGRATED_AGENT_TEMPLATE_KEY_PREFIX}.`;
  if (!templateKey.startsWith(prefix)) return '';
  const rest = templateKey.slice(prefix.length);
  if (!rest) return '';
  const match = /^(.*)\.m228(?:-\d+)?$/.exec(rest);
  return match ? (match[1] ?? '') : rest;
}

function collectSlotOccurrences(
  entries: Array<{ node: Record<string, unknown>; fallbackName: string }>
): SlotOccurrence[] {
  const occurrences: SlotOccurrence[] = [];
  for (const { node, fallbackName } of entries) {
    const agents = node.agents;
    if (!Array.isArray(agents) || agents.length === 0) {
      const legacyAgentId = typeof node.agentId === 'string' ? node.agentId.trim() : '';
      if (!legacyAgentId) continue;
      const configName = typeof node.name === 'string' && node.name.trim() ? node.name : '';
      const rawName = configName || fallbackName;
      occurrences.push({
        slot: { agentId: legacyAgentId, name: rawName || legacyAgentId },
        agentId: legacyAgentId,
        rawName,
        effectiveName: effectiveSlotName(rawName, legacyAgentId),
        node,
      });
      continue;
    }
    for (const raw of agents) {
      const slot = asRecord(raw);
      if (!slot) continue;
      const agentId = typeof slot.agentId === 'string' ? slot.agentId.trim() : '';
      const rawName = typeof slot.name === 'string' ? slot.name : '';
      occurrences.push({
        slot,
        agentId,
        rawName,
        effectiveName: effectiveSlotName(rawName, agentId),
      });
    }
  }
  return occurrences;
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

interface SlotClearingResult {
  clearedNames: Map<string, string>;
  dirty: boolean;
}

function clearMirrorSlots(
  occurrences: SlotOccurrence[],
  keyByAgentId: ReadonlyMap<string, string>,
  spaceByAgentId: ReadonlyMap<string, string>,
  spaceId: string | undefined,
  targets: ReadonlySet<string>,
  resolvable: (key: string) => boolean
): SlotClearingResult {
  const clearedNames = new Map<string, string>();
  let dirty = false;
  const occupied = new Set<string>();
  const newKeys = new Set(keyByAgentId.values());
  const slotNameCounts = new Map<string, number>();
  for (const occ of occurrences) {
    const name = occ.effectiveName.trim();
    if (name) slotNameCounts.set(name, (slotNameCounts.get(name) ?? 0) + 1);
  }
  const slotKeyCounts = new Map<string, number>();
  for (const occ of occurrences) {
    const key = typeof occ.slot.templateKey === 'string' ? occ.slot.templateKey.trim() : '';
    if (key) slotKeyCounts.set(key, (slotKeyCounts.get(key) ?? 0) + 1);
  }
  for (const occ of occurrences) {
    const finalName = occ.effectiveName;
    const slotKey = typeof occ.slot.templateKey === 'string' ? occ.slot.templateKey.trim() : '';
    let agentId = occ.agentId;
    let m228OwnedKey = false;
    if (!agentId) {
      const recovered = slotKey ? resolveMigratedAgentIdentity(slotKey) : '';
      if (!recovered || !keyByAgentId.has(recovered)) {
        if (finalName) occupied.add(finalName);
        if (slotKey) occupied.add(slotKey);
        continue;
      }
      agentId = recovered;
      occ.agentId = recovered;
      m228OwnedKey = true;
    } else if (slotKey && resolveMigratedAgentIdentity(slotKey) === agentId) {
      m228OwnedKey = true;
    }
    if (
      !keyByAgentId.has(agentId) ||
      (spaceId !== undefined && spaceByAgentId.get(agentId) !== spaceId)
    ) {
      const nameOwnedByEarlierSlot = finalName !== '' && occupied.has(finalName);
      if (slotKey && newKeys.has(slotKey) && !resolvable(slotKey)) {
        const slotName = typeof occ.slot.name === 'string' ? occ.slot.name.trim() : '';
        if (
          targets.has(slotKey) &&
          slotName !== '' &&
          !nameOwnedByEarlierSlot &&
          !occupied.has(slotName)
        ) {
          clearedNames.set(slotKey, occ.slot.name as string);
        }
        delete occ.slot.templateKey;
        dirty = true;
      }
      if (finalName) occupied.add(finalName);
      occupied.add(agentId);
      if (slotKey) occupied.add(slotKey);
      continue;
    }
    const existingKey = slotKey;
    const bindingKey =
      existingKey && resolvable(existingKey) && !m228OwnedKey
        ? existingKey
        : (keyByAgentId.get(agentId) ?? '');
    const selfNamedByKey = finalName.trim() === bindingKey;
    const keyNamedElsewhere = (slotNameCounts.get(bindingKey) ?? 0) > (selfNamedByKey ? 1 : 0);
    const selfBoundByKey = existingKey === bindingKey;
    const keyBoundElsewhere = (slotKeyCounts.get(bindingKey) ?? 0) > (selfBoundByKey ? 1 : 0);
    if (
      bindingKey !== '' &&
      targets.has(bindingKey) &&
      (keyNamedElsewhere || keyBoundElsewhere || occupied.has(bindingKey))
    ) {
      occupied.add(finalName);
      occupied.add(agentId);
      if (existingKey) occupied.add(existingKey);
      continue;
    }
    const keyTargeted = existingKey !== '' && targets.has(existingKey) && !m228OwnedKey;
    if (keyTargeted) {
      const candidateName = occ.rawName.trim() ? (occ.slot.name as string) : occ.agentId;
      const nameContested = candidateName === '' || occupied.has(candidateName);
      if (!nameContested) {
        if (occ.slot.templateKey !== bindingKey) {
          if (!occ.rawName.trim()) occ.slot.name = occ.agentId;
          occ.slot.templateKey = bindingKey;
          dirty = true;
          if (occ.node) occ.node.agents = [occ.slot];
        } else if (!occ.rawName.trim()) {
          occ.slot.name = occ.agentId;
          dirty = true;
          if (occ.node) occ.node.agents = [occ.slot];
        }
        if (existingKey && !occupied.has(existingKey) && !clearedNames.has(existingKey)) {
          clearedNames.set(existingKey, occ.slot.name as string);
          dirty = true;
        }
      }
      occupied.add(finalName);
      occupied.add(occ.agentId);
      if (existingKey) occupied.add(existingKey);
      if (bindingKey) occupied.add(bindingKey);
      continue;
    }
    const isRouteOwner = !occupied.has(occ.agentId);
    const nameUnique = !occupied.has(finalName);
    if (isRouteOwner && !nameUnique && targets.has(occ.agentId)) {
      if (occ.slot.templateKey !== bindingKey) {
        if (
          existingKey &&
          !clearedNames.has(existingKey) &&
          !occupied.has(existingKey) &&
          typeof occ.slot.name === 'string' &&
          occ.slot.name.trim()
        ) {
          clearedNames.set(existingKey, occ.slot.name);
        }
        occ.slot.templateKey = bindingKey;
        dirty = true;
      }
      if (occ.node) occ.node.agents = [occ.slot];
      occupied.add(finalName);
      occupied.add(occ.agentId);
      if (existingKey) occupied.add(existingKey);
      if (bindingKey) occupied.add(bindingKey);
      continue;
    }
    if (!occ.rawName.trim()) occ.slot.name = occ.agentId;
    if (
      existingKey !== bindingKey &&
      existingKey &&
      !clearedNames.has(existingKey) &&
      !occupied.has(existingKey)
    ) {
      clearedNames.set(existingKey, occ.slot.name as string);
    }
    if (isRouteOwner && nameUnique) {
      clearedNames.set(occ.agentId, occ.slot.name as string);
    }
    occ.slot.templateKey = bindingKey;
    occ.slot.agentId = '';
    dirty = true;
    if (occ.node) occ.node.agents = [occ.slot];
    occupied.add(finalName);
    occupied.add(occ.agentId);
    if (existingKey) occupied.add(existingKey);
    if (bindingKey) occupied.add(bindingKey);
  }
  return { clearedNames, dirty };
}

function collectConvertTargets(
  db: BunDatabase,
  agentRepo: SpaceLongHorizonAgentRepository
): SpaceLongHorizonAgent[] {
  const liveAgentIds = agentsWithLiveState(db);
  const referenced = referencedAgentIds(db);
  const spaces = db.prepare(`SELECT id FROM spaces`).all() as Array<{ id: string }>;
  const convert: SpaceLongHorizonAgent[] = [];
  for (const space of spaces) {
    for (const agent of agentRepo.listBySpaceId(space.id)) {
      if (agent.templateKey !== MIGRATED_WORKER_TEMPLATE_KEY) continue;
      if (
        agent.sessionId === null &&
        isPristineWorkerContent(agent) &&
        !referenced.has(agent.id) &&
        !liveAgentIds.has(agent.id)
      ) {
        if (
          agentRepo.listGoals(agent.id).length === 0 &&
          agentRepo.listForgeScopes(agent.id).length === 0 &&
          agentRepo.listReminders(agent.id).length === 0 &&
          agentRepo.listSubscriptions(agent.id).length === 0
        ) {
          continue;
        }
      }
      convert.push(agent);
    }
  }
  return convert;
}

export function runMigration241(db: BunDatabase): void {
  if (!tableExists(db, 'space_long_horizon_agents')) return;
  if (!tableExists(db, 'space_workflow_nodes')) return;
  if (!tableExists(db, 'space_agent_templates')) return;

  const agentRepo = new SpaceLongHorizonAgentRepository(db);
  const convert = collectConvertTargets(db, agentRepo);
  if (convert.length === 0) return;

  const templateRepo = new SpaceAgentTemplateRepository(db);
  const preExistingKeys = new Set(templateRepo.list().map((entry) => entry.key));
  const builtInKeys = new Set(getLongHorizonAgentTemplates().map((template) => template.key));
  const resolvable = (key: string): boolean => preExistingKeys.has(key) || builtInKeys.has(key);
  const restamp = db.prepare(
    `UPDATE space_long_horizon_agents SET template_key = ?, updated_at = ? WHERE id = ?`
  );
  const keyByAgentId = new Map<string, string>();
  const spaceByAgentId = new Map<string, string>();
  const now = Date.now();

  db.exec('BEGIN');
  try {
    for (const agent of convert) {
      const key = ensureWorkerCustomTemplate(templateRepo, agent);
      keyByAgentId.set(agent.id, key);
      spaceByAgentId.set(agent.id, agent.spaceId);
      restamp.run(key, now, agent.id);
    }
    rewriteLiveNodeSlots(db, keyByAgentId, spaceByAgentId, resolvable, now);
    rewritePinnedRunDefinitions(db, keyByAgentId, spaceByAgentId, resolvable, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function matchesWorkerCustomSynthesis(
  existing: SpaceAgentTemplate,
  params: CreateSpaceAgentTemplateParams
): boolean {
  if (!matchesSynthesis(existing, params)) return false;
  const normalizeLabels = (labels: string[] | null | undefined): string =>
    JSON.stringify([...(labels ?? [])].sort());
  return normalizeLabels(existing.labels) === normalizeLabels(params.labels);
}

function ensureWorkerCustomTemplate(
  repo: SpaceAgentTemplateRepository,
  agent: SpaceLongHorizonAgent
): string {
  const params = synthesizeWorkerCustomTemplate(agent);
  const baseKey = workerCustomTemplateKey(agent.id);

  const existing = repo.getByKey(baseKey);
  if (!existing) {
    repo.create({ ...params, key: baseKey });
    return baseKey;
  }
  if (matchesWorkerCustomSynthesis(existing, params)) return baseKey;

  for (let attempt = 0; attempt < MAX_TEMPLATE_KEY_ATTEMPTS; attempt++) {
    const key = attempt === 0 ? `${baseKey}.m241` : `${baseKey}.m241-${attempt + 1}`;
    const occupied = repo.getByKey(key);
    if (!occupied) {
      repo.create({ ...params, key });
      return key;
    }
    if (matchesWorkerCustomSynthesis(occupied, params)) return key;
  }
  throw new Error(
    `Could not find an available worker-custom template key for agent "${agent.id}" after ${MAX_TEMPLATE_KEY_ATTEMPTS} attempts`
  );
}

function rewriteLiveNodeSlots(
  db: BunDatabase,
  keyByAgentId: Map<string, string>,
  spaceByAgentId: Map<string, string>,
  resolvable: (key: string) => boolean,
  now: number
): void {
  const workflows = db
    .prepare(`SELECT id, space_id, post_approval FROM space_workflows ORDER BY rowid ASC`)
    .all() as WorkflowRow[];
  const workflowById = new Map(workflows.map((wf) => [wf.id, wf]));
  const nodes = db
    .prepare(`SELECT id, workflow_id, name, config FROM space_workflow_nodes ORDER BY rowid ASC`)
    .all() as NodeRow[];
  const updateNode = db.prepare(
    `UPDATE space_workflow_nodes SET config = ?, updated_at = ? WHERE id = ?`
  );
  const updateWorkflowPostApproval = db.prepare(
    `UPDATE space_workflows SET post_approval = ?, updated_at = ? WHERE id = ?`
  );

  const parsedById = new Map<string, Record<string, unknown>>();
  const nodesByWorkflow = new Map<string, NodeRow[]>();
  for (const node of nodes) {
    const parsed = parseJsonObject(node.config);
    if (parsed) parsedById.set(node.id, parsed);
    const list = nodesByWorkflow.get(node.workflow_id) ?? [];
    list.push(node);
    nodesByWorkflow.set(node.workflow_id, list);
  }

  for (const [workflowId, wfNodes] of nodesByWorkflow) {
    const workflow = workflowById.get(workflowId);
    const parsedNodes = wfNodes
      .map((node) => {
        const parsed = parsedById.get(node.id);
        return parsed ? { node: parsed, fallbackName: node.name } : null;
      })
      .filter(
        (entry): entry is { node: Record<string, unknown>; fallbackName: string } => entry !== null
      );
    if (parsedNodes.length === 0) continue;

    const targets = new Set<string>();
    addPostApprovalTarget(targets, parseJsonObject(workflow?.post_approval ?? null)?.targetAgent);
    for (const entry of parsedNodes) {
      addPostApprovalTarget(targets, asRecord(entry.node.postApproval)?.targetAgent);
    }

    const beforeById = new Map(
      wfNodes.map((node) => [
        node.id,
        parsedById.has(node.id) ? JSON.stringify(parsedById.get(node.id)) : null,
      ])
    );
    const { clearedNames } = clearMirrorSlots(
      collectSlotOccurrences(parsedNodes),
      keyByAgentId,
      spaceByAgentId,
      workflow?.space_id,
      targets,
      resolvable
    );

    for (const node of wfNodes) {
      const parsed = parsedById.get(node.id);
      const before = beforeById.get(node.id);
      if (!parsed || before === null) continue;
      const nodePostApproval = asRecord(parsed.postApproval);
      if (nodePostApproval) rewriteTargetAgent(nodePostApproval, clearedNames);
      const after = JSON.stringify(parsed);
      if (after !== before) updateNode.run(after, now, node.id);
    }

    const workflowPostApproval = parseJsonObject(workflow?.post_approval ?? null);
    if (workflowPostApproval) {
      const before = JSON.stringify(workflowPostApproval);
      rewriteTargetAgent(workflowPostApproval, clearedNames);
      if (JSON.stringify(workflowPostApproval) !== before) {
        updateWorkflowPostApproval.run(JSON.stringify(workflowPostApproval), now, workflowId);
      }
    }
  }
}

function rewritePinnedRunDefinitions(
  db: BunDatabase,
  keyByAgentId: Map<string, string>,
  spaceByAgentId: Map<string, string>,
  resolvable: (key: string) => boolean,
  now: number
): void {
  if (!tableExists(db, 'space_workflow_runs')) return;
  if (!tableExists(db, 'space_workflow_definition_versions')) return;

  const versionRepo = new SpaceWorkflowDefinitionVersionRepository(db);
  const repointRun = db.prepare(
    `UPDATE space_workflow_runs SET definition_version = ?, updated_at = ? WHERE id = ?`
  );
  const runs = db
    .prepare(
      `SELECT id, workflow_id, definition_version FROM space_workflow_runs
        WHERE definition_version IS NOT NULL ORDER BY rowid ASC`
    )
    .all() as RunRow[];

  for (const run of runs) {
    const definitionVersion = run.definition_version;
    if (!definitionVersion) continue;
    const version = versionRepo.getVersion(run.workflow_id, definitionVersion);
    if (!version) continue;
    if (!verifyDefinitionVersion(version.payload, definitionVersion)) continue;
    const workflow = parseJsonObject(version.payload);
    if (!workflow || !Array.isArray(workflow.nodes)) continue;

    const targets = new Set<string>();
    addPostApprovalTarget(targets, asRecord(workflow.postApproval)?.targetAgent);
    for (const rawNode of workflow.nodes) {
      addPostApprovalTarget(targets, asRecord(asRecord(rawNode)?.postApproval)?.targetAgent);
    }

    const { clearedNames: namesByAgentId, dirty } = clearMirrorSlots(
      collectSlotOccurrences(
        workflow.nodes
          .map(asRecord)
          .map((node) => (node ? { node, fallbackName: '' } : null))
          .filter(
            (entry): entry is { node: Record<string, unknown>; fallbackName: string } =>
              entry !== null
          )
      ),
      keyByAgentId,
      spaceByAgentId,
      version.spaceId,
      targets,
      resolvable
    );
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
      spaceId: version.spaceId,
      versionHash,
      payload: rewrittenPayload,
      source: 'backfill',
      createdAt: now,
    });
    repointRun.run(versionHash, now, run.id);
  }
}
