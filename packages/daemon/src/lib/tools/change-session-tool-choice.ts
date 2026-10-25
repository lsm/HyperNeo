import type {
  SessionToolChoiceKey,
  SessionToolSelection,
} from '@hyperneo/shared/types/session-tool-choice';
import type {
  RuntimeSettingsPatch,
  SessionRuntimeSettingsSnapshot,
} from '../../storage/repositories/session-runtime-settings-write.ts';
import type { SessionToolChoiceInput } from './session-tool-choice.ts';

export interface SessionToolChoiceChange {
  sessionId: string;
  key: SessionToolChoiceKey;
  selected: boolean;
}
export interface SessionToolChoiceChangeDependencies {
  capture: (id: string) => SessionRuntimeSettingsSnapshot | null;
  commit: (
    snapshot: SessionRuntimeSettingsSnapshot,
    patch: RuntimeSettingsPatch
  ) => Promise<'won' | 'superseded'>;
  catalog: (snapshot: SessionRuntimeSettingsSnapshot) => Omit<SessionToolChoiceInput, 'session'>;
}
export type SessionToolChoiceChangeResult =
  | { ok: false; reason: string }
  | { ok: true; changed: boolean; selection: SessionToolSelection };

export async function changeSessionToolChoice(
  _input: SessionToolChoiceChange,
  _deps: SessionToolChoiceChangeDependencies
): Promise<SessionToolChoiceChangeResult> {
  return { ok: false, reason: 'session_not_found' };
}
