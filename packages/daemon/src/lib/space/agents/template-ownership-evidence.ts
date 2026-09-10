import { MIGRATED_AGENT_TEMPLATE_KEY_PREFIX } from './agent-template-synthesis.ts';

export const TEMPLATE_OWNERSHIP_AUDIT_TOOL = 'create_agent_template';

export interface TemplateOwnershipAgentRow {
  id: string;
  spaceId: string;
  templateKey: string | null;
}

export interface TemplateOwnershipSlotRow {
  spaceId: string;
  templateKey: string | null;
}

export interface TemplateOwnershipAuditRow {
  spaceId: string | null;
  toolName: string;
  paramsSummary: string | null;
}

export interface TemplateOwnershipInputs {
  templateKeys: readonly string[];
  agents: readonly TemplateOwnershipAgentRow[];
  workflowSlots: readonly TemplateOwnershipSlotRow[];
  auditEntries: readonly TemplateOwnershipAuditRow[];
}

export interface TemplateOwnershipEvidence {
  migratedAgentSpaces: string[];
  agentReferenceSpaces: string[];
  workflowSlotSpaces: string[];
  auditedSpaces: string[];
}

const MIGRATED_KEY_PREFIX = `${MIGRATED_AGENT_TEMPLATE_KEY_PREFIX}.`;
const PROBE_SUFFIX = /\.m228(?:-\d+)?$/;

function emptyEvidence(): TemplateOwnershipEvidence {
  return {
    migratedAgentSpaces: [],
    agentReferenceSpaces: [],
    workflowSlotSpaces: [],
    auditedSpaces: [],
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

export function auditedTemplateKey(entry: TemplateOwnershipAuditRow): string | null {
  if (entry.toolName !== TEMPLATE_OWNERSHIP_AUDIT_TOOL) return null;
  if (typeof entry.paramsSummary !== 'string' || entry.paramsSummary === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.paramsSummary);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const key = (parsed as Record<string, unknown>).key;
  return typeof key === 'string' && key.trim() !== '' ? key.trim() : null;
}

export function collectTemplateOwnershipEvidence(
  inputs: TemplateOwnershipInputs
): Map<string, TemplateOwnershipEvidence> {
  const evidence = new Map<string, TemplateOwnershipEvidence>();
  for (const key of inputs.templateKeys) {
    const trimmed = normalizeKey(key);
    if (trimmed) evidence.set(trimmed, emptyEvidence());
  }

  const spaceByAgentId = new Map<string, string>();
  for (const agent of inputs.agents) {
    const id = normalizeKey(agent.id);
    const space = normalizeKey(agent.spaceId);
    if (id && space) spaceByAgentId.set(id, space);
  }

  for (const [key, entry] of evidence) {
    for (const candidate of migratedAgentIdCandidates(key)) {
      const space = spaceByAgentId.get(candidate);
      if (space) {
        addSpace(entry.migratedAgentSpaces, space);
        break;
      }
    }
  }

  for (const agent of inputs.agents) {
    const referenced = normalizeKey(agent.templateKey);
    const entry = referenced ? evidence.get(referenced) : undefined;
    if (entry) addSpace(entry.agentReferenceSpaces, agent.spaceId);
  }

  for (const slot of inputs.workflowSlots) {
    const key = normalizeKey(slot.templateKey);
    const entry = key ? evidence.get(key) : undefined;
    if (entry) addSpace(entry.workflowSlotSpaces, slot.spaceId);
  }

  for (const audit of inputs.auditEntries) {
    const key = auditedTemplateKey(audit);
    const entry = key ? evidence.get(key) : undefined;
    if (entry) addSpace(entry.auditedSpaces, audit.spaceId);
  }

  return evidence;
}
