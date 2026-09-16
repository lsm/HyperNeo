import type { EvolutionScope } from '@hyperneo/shared';
import type {
  ConversationFrictionAnalysis,
  ConversationFrictionPattern,
} from './conversation-analysis-types.ts';
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  PATTERN_KINDS,
  SEVERITIES,
} from './conversation-analysis-types.ts';

export function parseConversationFrictionJson(raw: string): ConversationFrictionAnalysis {
  const text = extractJsonText(raw.trim());
  return normalizeAnalysis(JSON.parse(text));
}

function extractJsonText(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim();
  if (fenced) return fenced;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
}

function normalizeAnalysis(value: unknown): ConversationFrictionAnalysis {
  const record = requireRecord(value, 'conversation friction analysis');
  return {
    patterns: Array.isArray(record.patterns)
      ? record.patterns.flatMap((pattern) => {
          try {
            return [normalizePattern(pattern)];
          } catch {
            return [];
          }
        })
      : [],
    humanInterventionCount: readCount(record.humanInterventionCount),
    syntheticInterventionCount: readCount(record.syntheticInterventionCount),
    agentUncertaintyCount: readCount(record.agentUncertaintyCount),
    overallAssessment:
      typeof record.overallAssessment === 'string' ? record.overallAssessment : 'No assessment',
  };
}

function normalizePattern(value: unknown): ConversationFrictionPattern {
  const record = requireRecord(value, 'conversation friction pattern');
  return {
    kind: enumValue(record.kind, PATTERN_KINDS, 'pattern.kind'),
    confidence: normalizeConfidence(record.confidence),
    summary: typeof record.summary === 'string' ? record.summary : 'Conversation friction detected',
    involvedMessages: stringArray(record.involvedMessages),
    severity: enumValue(record.severity ?? 'low', SEVERITIES, 'pattern.severity'),
  };
}

export function readConfidenceThreshold(scope: EvolutionScope): number {
  return normalizeConfidence(
    scope.policy.conversationFrictionConfidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD
  );
}

export function normalizeConfidence(value: unknown): number {
  const number =
    typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_CONFIDENCE_THRESHOLD;
  return Math.max(0, Math.min(1, number));
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string
): T[number] {
  if (typeof value === 'string' && allowed.includes(value)) return value as T[number];
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) throw new Error(`Expected ${label} object`);
  return record;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
