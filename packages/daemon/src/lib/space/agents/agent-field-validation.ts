import type { SpaceAgentStatus } from '@hyperneo/shared';

const THINKING_LEVELS = new Set(['off', 'think8k', 'think16k', 'think24k', 'think32k']);

export function isValidThinkingLevel(value: unknown): boolean {
  return typeof value === 'string' && THINKING_LEVELS.has(value);
}

const SETTING_SOURCES = new Set(['user', 'project', 'local']);
const AGENT_STATUSES = new Set(['active', 'paused', 'disabled', 'archived']);

const STRING_FIELDS = [
  'handle',
  'displayName',
  'description',
  'instructions',
  'model',
  'provider',
  'sessionId',
] as const;

const NON_BLANK_FIELDS = [
  { field: 'displayName', message: 'displayName cannot be blank' },
  { field: 'handle', message: 'handle cannot be blank' },
  { field: 'model', message: 'model cannot be blank — use null to clear it' },
  { field: 'provider', message: 'provider cannot be blank — use null to clear it' },
] as const;

export interface AgentFieldValues {
  handle?: string;
  displayName?: string;
  description?: string | null;
  instructions?: string;
  model?: string | null;
  provider?: string | null;
  sessionId?: string | null;
  status?: SpaceAgentStatus;
  tools?: string[] | null;
  thinkingLevel?: string | null;
  settingSources?: string[] | null;
  autonomyLevel?: number | null;
}

function isBlankString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === '';
}

export function firstAgentFieldError(fields: AgentFieldValues): string | null {
  for (const field of STRING_FIELDS) {
    const value = fields[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return `${field} must be a string`;
  }

  if (
    fields.tools !== undefined &&
    fields.tools !== null &&
    (!Array.isArray(fields.tools) || fields.tools.some((tool) => typeof tool !== 'string'))
  ) {
    return 'tools must be an array of strings';
  }

  for (const { field, message } of NON_BLANK_FIELDS) {
    if (isBlankString(fields[field])) return message;
  }

  if (
    fields.thinkingLevel !== undefined &&
    fields.thinkingLevel !== null &&
    !isValidThinkingLevel(fields.thinkingLevel)
  ) {
    return `Invalid thinkingLevel: ${String(fields.thinkingLevel)}`;
  }

  if (fields.settingSources !== undefined && fields.settingSources !== null) {
    if (!Array.isArray(fields.settingSources)) {
      return 'settingSources must be an array';
    }
    const invalid = fields.settingSources.filter((source) => !SETTING_SOURCES.has(source));
    if (invalid.length > 0) {
      return `Invalid settingSources: ${invalid.join(', ')}`;
    }
  }

  if (
    fields.status !== undefined &&
    (typeof fields.status !== 'string' || !AGENT_STATUSES.has(fields.status))
  ) {
    return `Invalid status: ${String(fields.status)}`;
  }

  if (
    fields.autonomyLevel !== undefined &&
    fields.autonomyLevel !== null &&
    !(
      Number.isInteger(fields.autonomyLevel) &&
      fields.autonomyLevel >= 1 &&
      fields.autonomyLevel <= 5
    )
  ) {
    return `Invalid autonomyLevel: ${String(fields.autonomyLevel)}`;
  }

  return null;
}
