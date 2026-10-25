import { parseJson, type SessionConfig } from '@hyperneo/shared';
import type {
  ResolvedSessionToolChoice,
  SessionToolChoiceKey,
  SessionToolSelection,
} from '@hyperneo/shared/types/session-tool-choice';
import { isDeepStrictEqual } from 'node:util';
import superpipe, { type PipelineAPI } from 'superpipe';
import type {
  RuntimeSettingsPatch,
  SessionRuntimeSettingsSnapshot,
} from '../../storage/repositories/session-runtime-settings-write.ts';
import {
  projectLegacySessionToolSelection,
  resolveSessionToolChoices,
  type SessionToolChoiceInput,
} from './session-tool-choice.ts';

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
type Refusal =
  | Exclude<ResolvedSessionToolChoice['reason'], 'selected'>
  | 'session_not_found'
  | 'session_closed'
  | 'selection_version_unsupported'
  | 'superseded';
type Failure = { ok: false; reason: Refusal };
type Gate<T> = { value: T } | { reason: Failure };
export type SessionToolChoiceChangeResult =
  | Failure
  | { ok: true; changed: boolean; selection: SessionToolSelection };
interface PreparedChoice {
  snapshot: SessionRuntimeSettingsSnapshot;
  selection: SessionToolSelection;
  changed: boolean;
}

function captureChoice(
  input: SessionToolChoiceChange,
  deps: SessionToolChoiceChangeDependencies
): Gate<SessionRuntimeSettingsSnapshot> {
  const snapshot = deps.capture(input.sessionId);
  return snapshot ? { value: snapshot } : { reason: { ok: false, reason: 'session_not_found' } };
}
function gateWritable(
  snapshot: SessionRuntimeSettingsSnapshot
): Gate<SessionRuntimeSettingsSnapshot> {
  return snapshot.archivedAt !== null || ['archived', 'ended'].includes(snapshot.status)
    ? { reason: { ok: false, reason: 'session_closed' } }
    : { value: snapshot };
}
function prepareChoice(
  snapshot: SessionRuntimeSettingsSnapshot,
  input: SessionToolChoiceChange,
  deps: SessionToolChoiceChangeDependencies
): Gate<PreparedChoice> {
  const config = JSON.parse(snapshot.config) as SessionConfig;
  const current = config.toolSelection;
  if (current && current.version !== 1)
    return { reason: { ok: false, reason: 'selection_version_unsupported' } };
  const catalog: SessionToolChoiceInput = {
    ...deps.catalog(snapshot),
    session: { id: snapshot.id, context: parseJson(snapshot.sessionContext, {}) },
  };
  catalog.disabledSkillIds = [
    ...(catalog.disabledSkillIds ?? []),
    ...(config.tools?.disabledSkills ?? []),
  ];
  const original = current ?? projectLegacySessionToolSelection(catalog);
  const saved = original.choices[input.key];
  const selection: SessionToolSelection = {
    ...original,
    choices: { ...original.choices, [input.key]: { ...saved, selected: input.selected } },
  };
  const target = resolveSessionToolChoices(catalog, selection).find(
    (choice) => choice.key === input.key
  );
  if (!target || target.reason === 'missing-definition')
    return { reason: { ok: false, reason: 'missing-definition' } };
  if (input.selected && target.reason !== 'selected')
    return { reason: { ok: false, reason: target.reason } };
  const aliases = saved?.aliases?.length
    ? saved.aliases
    : target.aliases.length === 1
      ? target.aliases
      : [];
  selection.choices[input.key] = { selected: input.selected, aliases: [...aliases] };
  return { value: { snapshot, selection, changed: !isDeepStrictEqual(current, selection) } };
}
async function commitChoice(
  prepared: PreparedChoice,
  deps: SessionToolChoiceChangeDependencies
): Promise<SessionToolChoiceChangeResult> {
  return (await deps.commit(prepared.snapshot, { toolSelection: prepared.selection })) === 'won'
    ? { ok: true, selection: prepared.selection, changed: prepared.changed }
    : { ok: false, reason: 'superseded' };
}

export const changeSessionToolChoice = (superpipe({})('change-session-tool-choice') as PipelineAPI)
  .input(['input', 'deps'])
  .pipe(captureChoice, ['input', 'deps'], 'result:change')
  .pipe(gateWritable, 'change', 'result:change')
  .pipe(prepareChoice, ['change', 'input', 'deps'], 'result:change')
  .pipe(commitChoice, ['change', 'deps'], 'change')
  .endAsync('change') as (
  input: SessionToolChoiceChange,
  deps: SessionToolChoiceChangeDependencies
) => Promise<SessionToolChoiceChangeResult>;
