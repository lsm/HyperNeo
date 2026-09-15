import type { AgentModelPoolEntry, SpaceAgentAutonomyLevel } from '@hyperneo/shared';
import { validateSlug } from '../space/slug.ts';
import { MIGRATED_AGENT_TEMPLATE_KEY_PREFIX } from './template-synthesis.ts';
import { MIGRATED_WORKER_TEMPLATE_KEY } from './worker-long-horizon-mapper.ts';
import {
  getLongHorizonAgentTemplate,
  isLegacyWorkerTemplateKey,
  isRelocationMarkerLabel,
  RETIRED_LONG_HORIZON_TEMPLATE_KEYS,
} from './long-horizon-templates.ts';
import {
  validateAgentModel,
  validateAgentModelPool,
  validateSpaceAgentTools,
} from './validation.ts';

const MIN_AUTONOMY: SpaceAgentAutonomyLevel = 1;
const MAX_AUTONOMY: SpaceAgentAutonomyLevel = 5;
const MAX_LABELS = 8;
const MAX_LABEL_LENGTH = 64;
const MAX_LABEL_ENTRIES = 64;
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u;
const DEFAULT_IGNORABLE =
  /[\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180D\u180F\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/u;

export function validateTemplateKey(key: string): string | null {
  if (!key || key.trim() !== key) {
    return 'Template key cannot be empty or have leading/trailing whitespace';
  }
  if (key === MIGRATED_WORKER_TEMPLATE_KEY) {
    return `Template key "${key}" is reserved`;
  }
  if ((RETIRED_LONG_HORIZON_TEMPLATE_KEYS as readonly string[]).includes(key)) {
    return `Template key "${key}" is retired and cannot be reused`;
  }
  if (getLongHorizonAgentTemplate(key) || isLegacyWorkerTemplateKey(key)) {
    return `Template key "${key}" is reserved for a built-in agent template`;
  }
  if (
    key === MIGRATED_AGENT_TEMPLATE_KEY_PREFIX ||
    key.startsWith(`${MIGRATED_AGENT_TEMPLATE_KEY_PREFIX}.`)
  ) {
    return `Template key "${key}" is reserved for templates migration 228 synthesized from agents`;
  }
  return null;
}

export function validateTemplateHandle(handle: string): string | null {
  const trimmed = handle.trim();
  if (trimmed !== handle) return 'Template handle must not have leading or trailing whitespace';
  const slugError = validateSlug(trimmed);
  return slugError ? `Invalid template handle: ${slugError}` : null;
}

export function validateAutonomyLevel(level: SpaceAgentAutonomyLevel | undefined): string | null {
  if (level === undefined) return null;
  if (!Number.isInteger(level) || level < MIN_AUTONOMY || level > MAX_AUTONOMY) {
    return `Suggested autonomy level must be an integer between ${MIN_AUTONOMY} and ${MAX_AUTONOMY}`;
  }
  return null;
}

export function validateDisplayName(displayName: string | undefined | null): string | null {
  if (displayName === undefined || displayName === null) return null;
  if (displayName.trim() === '') return 'Template display name cannot be blank';
  return null;
}

export function validateToolsChoice(tools: string[] | null | undefined): string | null {
  if (tools === undefined || tools === null) return null;
  return validateSpaceAgentTools(tools);
}

export function stripRelocationMarkerLabels(
  labels: string[] | null | undefined
): string[] | null | undefined {
  if (labels === undefined || labels === null || !Array.isArray(labels)) return labels;
  return labels.filter(
    (label) => typeof label !== 'string' || !isRelocationMarkerLabel(label.trim().normalize('NFC'))
  );
}

export function normalizeTemplateLabels(labels: string[] | null | undefined): {
  labels: string[];
  error: string | null;
} {
  if (labels === undefined || labels === null) return { labels: [], error: null };
  if (!Array.isArray(labels)) {
    return { labels: [], error: 'Template labels must be an array of strings' };
  }
  if (labels.length > MAX_LABEL_ENTRIES) {
    return {
      labels: [],
      error: `Template label arrays are limited to ${MAX_LABEL_ENTRIES} entries`,
    };
  }
  const normalized: string[] = [];
  for (const label of labels) {
    if (typeof label !== 'string') {
      return { labels: [], error: 'Template labels must be strings' };
    }
    if (label.length > MAX_LABEL_LENGTH) {
      return {
        labels: [],
        error: `Template labels are limited to ${MAX_LABEL_LENGTH} characters`,
      };
    }
    const trimmed = label.trim().normalize('NFC');
    if (trimmed === '') {
      return { labels: [], error: 'Template labels cannot be blank' };
    }
    if (NON_PRINTABLE.test(trimmed) || DEFAULT_IGNORABLE.test(trimmed)) {
      return { labels: [], error: 'Template labels must contain only printable characters' };
    }
    if (normalized.includes(trimmed)) continue;
    if (normalized.length >= MAX_LABELS) {
      return { labels: [], error: `Template labels are limited to ${MAX_LABELS} entries` };
    }
    normalized.push(trimmed);
  }
  return { labels: normalized, error: null };
}

export async function validateModelChoice(
  model: string | null | undefined,
  provider: string | null | undefined
): Promise<string | null> {
  if (provider !== undefined && provider !== null && provider.trim() === '') {
    return 'Provider identifier cannot be blank';
  }
  if (model === undefined || model === null) return null;
  if (model.trim() === '') return 'Model identifier cannot be blank';
  return validateAgentModel(model, provider);
}

export async function validateTemplateModelPool(
  pool: AgentModelPoolEntry[] | null | undefined
): Promise<string | null> {
  if (pool === undefined || pool === null || pool.length === 0) return null;
  for (const entry of pool) {
    if (!entry.model || entry.model.trim() === '') return 'Model pool entries must specify a model';
    if (entry.provider !== undefined && entry.provider.trim() === '') {
      return `Provider identifier cannot be blank for model pool entry "${entry.model}"`;
    }
  }
  const baseError = await validateAgentModelPool(pool);
  if (baseError) return baseError;
  for (const entry of pool) {
    const error = await validateAgentModel(entry.model, entry.provider);
    if (error) return error;
  }
  return null;
}
