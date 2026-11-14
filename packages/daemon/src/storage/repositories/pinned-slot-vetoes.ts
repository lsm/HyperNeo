import { parseJson } from '@hyperneo/shared';
import type { PromptProvenanceInit } from '../../lib/agent/agent-session.ts';
import type { Database } from '../sqlite-compat.ts';
import { extensionSessionSkillVetoes } from '../schema/extensions.ts';

function parseObject<T extends object>(raw: string | null | undefined): T | null {
  const value = parseJson<unknown>(raw ?? '{}', null);
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : null;
}

export function pinnedSlotVetoes(db: Database, metadata: string | null | undefined): string[] {
  const provenance = parseObject<{ promptProvenance?: PromptProvenanceInit }>(
    metadata
  )?.promptProvenance;
  return provenance ? extensionSessionSkillVetoes(db, provenance) : [];
}
