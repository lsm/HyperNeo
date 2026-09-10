import { MIGRATED_AGENT_TEMPLATE_KEY_PREFIX } from './agent-template-synthesis.ts';

export interface TemplateOwnershipAgentRow {
  id: string;
  spaceId: string;
  templateKey: string | null;
  createdAt: number;
}

export interface TemplateOwnershipSlotRow {
  spaceId: string;
  templateKey: string | null;
}

export interface TemplateOwnershipTemplateRow {
  key: string;
  createdAt: number;
}

export interface TemplateOwnershipInputs {
  templates: readonly TemplateOwnershipTemplateRow[];
  agents: readonly TemplateOwnershipAgentRow[];
  workflowSlots: readonly TemplateOwnershipSlotRow[];
}

export interface TemplateOwnershipEvidence {
  migratedAgentSpaces: string[];
  agentReferenceSpaces: string[];
  workflowSlotSpaces: string[];
}

const MIGRATED_KEY_PREFIX = `${MIGRATED_AGENT_TEMPLATE_KEY_PREFIX}.`;
const PROBE_SUFFIX = /\.m228(?:-\d+)?$/;

function emptyEvidence(): TemplateOwnershipEvidence {
  return {
    migratedAgentSpaces: [],
    agentReferenceSpaces: [],
    workflowSlotSpaces: [],
  };
}

function addSpace(target: string[], spaceId: string | null | undefined): void {
  const trimmed = typeof spaceId === 'string' ? spaceId.trim() : '';
  if (!trimmed || target.includes(trimmed)) return;
  target.push(trimmed);
}

function normalizeKey(key: string | null | undefined): string {
  return typeof key === 'string' ? key.trim() : '';
}

export function migratedAgentIdCandidates(key: string): string[] {
  if (!key.startsWith(MIGRATED_KEY_PREFIX)) return [];
  const remainder = key.slice(MIGRATED_KEY_PREFIX.length);
  if (remainder === '') return [];
  const candidates = [remainder];
  const stripped = remainder.replace(PROBE_SUFFIX, '');
  if (stripped !== remainder && stripped !== '') candidates.push(stripped);
  return candidates;
}

export function collectTemplateOwnershipEvidence(
  inputs: TemplateOwnershipInputs
): Map<string, TemplateOwnershipEvidence> {
  const evidence = new Map<string, TemplateOwnershipEvidence>();
  const createdAtByKey = new Map<string, number>();
  for (const template of inputs.templates) {
    const trimmed = normalizeKey(template.key);
    if (!trimmed) continue;
    evidence.set(trimmed, emptyEvidence());
    createdAtByKey.set(trimmed, template.createdAt);
  }

  const agentsById = new Map<string, TemplateOwnershipAgentRow>();
  for (const agent of inputs.agents) {
    const id = normalizeKey(agent.id);
    if (id && normalizeKey(agent.spaceId)) agentsById.set(id, agent);
  }

  for (const [key, entry] of evidence) {
    const createdAt = createdAtByKey.get(key);
    if (createdAt === undefined) continue;
    for (const candidate of migratedAgentIdCandidates(key)) {
      const agent = agentsById.get(candidate);
      if (agent && agent.createdAt <= createdAt) {
        addSpace(entry.migratedAgentSpaces, agent.spaceId);
      }
    }
  }

  for (const agent of inputs.agents) {
    const referenced = normalizeKey(agent.templateKey);
    if (!referenced) continue;
    const entry = evidence.get(referenced);
    const createdAt = createdAtByKey.get(referenced);
    if (!entry || createdAt === undefined) continue;
    if (agent.createdAt < createdAt) continue;
    addSpace(entry.agentReferenceSpaces, agent.spaceId);
  }

  for (const slot of inputs.workflowSlots) {
    const key = normalizeKey(slot.templateKey);
    const entry = key ? evidence.get(key) : undefined;
    if (entry) addSpace(entry.workflowSlotSpaces, slot.spaceId);
  }

  return evidence;
}
