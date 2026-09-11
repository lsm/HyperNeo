import { MIGRATED_AGENT_TEMPLATE_KEY_PREFIX } from './agent-template-synthesis.ts';

export interface TemplateOwnershipTemplateRow {
  key: string;
  createdAt: number;
}

export interface TemplateOwnershipAgentRow {
  id: string;
  spaceId: string;
  createdAt: number;
}

export interface TemplateOwnershipSlotRow {
  spaceId: string;
  templateKey: string | null;
}

export interface TemplateOwnershipInputs {
  templates: readonly TemplateOwnershipTemplateRow[];
  agents: readonly TemplateOwnershipAgentRow[];
  workflowSlots: readonly TemplateOwnershipSlotRow[];
}

export interface TemplateOwnershipEvidence {
  synthesizedFromSpaces: string[];
  workflowSlotSpaces: string[];
}

const MIGRATED_KEY_PREFIX = `${MIGRATED_AGENT_TEMPLATE_KEY_PREFIX}.`;
const PROBE_SUFFIX = /\.m228(?:-(\d+))?$/;
const MIN_M228_PROBE = 2;
const MAX_M228_PROBE = 100;

function m228ProbeStripped(remainder: string): string | null {
  const match = PROBE_SUFFIX.exec(remainder);
  if (!match) return null;
  const ordinal = match[1];
  if (ordinal !== undefined) {
    const parsed = Number(ordinal);
    if (String(parsed) !== ordinal) return null;
    if (parsed < MIN_M228_PROBE || parsed > MAX_M228_PROBE) return null;
  }
  const stripped = remainder.slice(0, match.index);
  return stripped === '' ? null : stripped;
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
  const stripped = m228ProbeStripped(remainder);
  if (stripped !== null) candidates.push(stripped);
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
    evidence.set(trimmed, { synthesizedFromSpaces: [], workflowSlotSpaces: [] });
    createdAtByKey.set(trimmed, template.createdAt);
  }

  const agentsById = new Map<string, TemplateOwnershipAgentRow>();
  for (const agent of inputs.agents) {
    if (agent.id === '' || normalizeKey(agent.spaceId) === '') continue;
    agentsById.set(agent.id, agent);
  }

  for (const [key, entry] of evidence) {
    const createdAt = createdAtByKey.get(key);
    if (createdAt === undefined) continue;
    for (const candidate of migratedAgentIdCandidates(key)) {
      const agent = agentsById.get(candidate);
      if (agent && agent.createdAt <= createdAt) {
        addSpace(entry.synthesizedFromSpaces, agent.spaceId);
      }
    }
  }

  for (const slot of inputs.workflowSlots) {
    const key = normalizeKey(slot.templateKey);
    const entry = key ? evidence.get(key) : undefined;
    if (entry) addSpace(entry.workflowSlotSpaces, slot.spaceId);
  }

  return evidence;
}
