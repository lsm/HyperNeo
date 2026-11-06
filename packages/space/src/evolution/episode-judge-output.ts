import type {
  CreateEvolutionLessonParams,
  CreateTaskProposalParams,
  EvolutionFinding,
  EvolutionFindingDomain,
  EvolutionFindingKind,
  EvolutionImpact,
  EvolutionLessonStatus,
  SpaceTaskPriority,
  TaskProposalStatus,
} from '@hyperneo/shared';
import type { EpisodeJudgeOutput } from './episode-service-types.ts';
import { truncate } from './episode-judge-prompt.ts';

const FINDING_DOMAINS: EvolutionFindingDomain[] = [
  'workflow',
  'target_artifact',
  'hyperneo_product',
];
const FINDING_KINDS: EvolutionFindingKind[] = [
  'friction',
  'bug',
  'optimization',
  'missing_capability',
  'new_opportunity',
];
const IMPACTS: EvolutionImpact[] = ['low', 'medium', 'high'];
const LESSON_STATUSES: EvolutionLessonStatus[] = ['candidate', 'active', 'dismissed'];
const PROPOSAL_STATUSES: TaskProposalStatus[] = ['proposed', 'accepted', 'dismissed', 'created'];
const PRIORITIES: SpaceTaskPriority[] = ['low', 'normal', 'high', 'urgent'];

export function parseEpisodeJudgeJson(raw: string): EpisodeJudgeOutput {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    text = fenced[1].trim();
  } else {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0) {
      throw new Error(`Episode judge returned non-JSON text: ${truncate(text, 300)}`);
    }
    if (end > start) text = text.slice(start, end + 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Episode judge returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return normalizeJudgeOutput(parsed);
}

function normalizeJudgeOutput(value: unknown): EpisodeJudgeOutput {
  const record = requireRecord(value, 'episode judge output');
  const title = requireString(record.title, 'title');
  const outcomeSummary = requireString(record.outcomeSummary, 'outcomeSummary');
  const findingsValue = Array.isArray(record.findings) ? record.findings : [];
  const findings = findingsValue.map(normalizeFinding);
  const candidateLessons = Array.isArray(record.candidateLessons)
    ? record.candidateLessons.map(normalizeLesson)
    : [];
  const proposals = Array.isArray(record.proposals) ? record.proposals.map(normalizeProposal) : [];
  return { title, outcomeSummary, findings, candidateLessons, proposals };
}

function normalizeFinding(value: unknown): EvolutionFinding {
  const record = requireRecord(value, 'finding');
  return {
    domain: enumValue(record.domain, FINDING_DOMAINS, 'finding.domain'),
    kind: enumValue(record.kind, FINDING_KINDS, 'finding.kind'),
    impact: enumValue(record.impact, IMPACTS, 'finding.impact'),
    confidence: clampConfidence(record.confidence),
    evidence: stringArray(record.evidence),
    proposedAction: requireString(record.proposedAction, 'finding.proposedAction'),
  };
}

function normalizeLesson(
  value: unknown
): Omit<CreateEvolutionLessonParams, 'scopeId' | 'evidenceEpisodeIds'> {
  const record = requireRecord(value, 'candidate lesson');
  return {
    status:
      record.status === undefined
        ? 'candidate'
        : enumValue(record.status, LESSON_STATUSES, 'lesson.status'),
    appliesTo: stringArray(record.appliesTo),
    rule: requireString(record.rule, 'lesson.rule'),
    why: requireString(record.why, 'lesson.why'),
    confidence: clampConfidence(record.confidence),
  };
}

function normalizeProposal(
  value: unknown
): Omit<CreateTaskProposalParams, 'scopeId' | 'evidenceEpisodeIds'> {
  const record = requireRecord(value, 'proposal');
  return {
    title: requireString(record.title, 'proposal.title'),
    description: requireString(record.description, 'proposal.description'),
    reason: requireString(record.reason, 'proposal.reason'),
    priority: enumValue(record.priority ?? 'normal', PRIORITIES, 'proposal.priority'),
    status:
      record.status === undefined
        ? 'proposed'
        : enumValue(record.status, PROPOSAL_STATUSES, 'proposal.status'),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function clampConfidence(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(1, numeric));
}
