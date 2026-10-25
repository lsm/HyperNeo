import type { AppMcpServer, AppSkill } from '@hyperneo/shared';
import type {
  ResolvedSessionToolChoice,
  SessionToolSelection,
} from '@hyperneo/shared/types/session-tool-choice';
import type { SessionToolChoiceInput } from './session-tool-choice.ts';

type Unsupported = { ok: false; reason: 'selection_version_unsupported' };
export type SessionToolInputs =
  | Unsupported
  | {
      ok: true;
      instructionSkills: AppSkill[];
      catalogServers: Array<{ alias: string; server: AppMcpServer }>;
      choices: ResolvedSessionToolChoice[];
    };
export type InitialSessionToolSelection =
  | Unsupported
  | { ok: true; selection: SessionToolSelection };

export function projectSessionToolInputs(
  _catalog: SessionToolChoiceInput,
  _selection: SessionToolSelection
): SessionToolInputs {
  return { ok: false, reason: 'selection_version_unsupported' };
}
export function prepareInitialSessionToolSelection(
  _catalog: SessionToolChoiceInput,
  _initialVetoes: readonly string[],
  _defaults?: SessionToolSelection
): InitialSessionToolSelection {
  return { ok: false, reason: 'selection_version_unsupported' };
}
