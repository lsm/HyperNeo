import type { SessionConfig } from '@hyperneo/shared';
import type {
  SessionToolChoiceKey,
  SessionToolSelection,
} from '@hyperneo/shared/types/session-tool-choice';
import type { SessionToolChoiceInput } from './session-tool-choice.ts';

export type LegacyToolPreference =
  | { kind: 'skills'; disabledSkills: readonly string[] }
  | { kind: 'mcp'; serverId: string; enabled: boolean | null };
export type LegacyToolPreferenceResult =
  | {
      ok: false;
      reason: 'missing-definition' | 'ambiguous-alias' | 'selection_version_unsupported';
    }
  | { ok: true; changes: Array<{ key: SessionToolChoiceKey; selected: boolean }> };
export function translateLegacyToolPreference(
  _catalog: SessionToolChoiceInput,
  _config: SessionConfig,
  _request: LegacyToolPreference,
  _defaults?: SessionToolSelection
): LegacyToolPreferenceResult {
  return { ok: false, reason: 'missing-definition' };
}
export function projectLegacyToolDefaultUpdate(
  _before: SessionToolChoiceInput,
  _after: SessionToolChoiceInput,
  _defaults?: SessionToolSelection
):
  | { ok: true; selection: SessionToolSelection }
  | { ok: false; reason: 'selection_version_unsupported' } {
  return { ok: false, reason: 'selection_version_unsupported' };
}
