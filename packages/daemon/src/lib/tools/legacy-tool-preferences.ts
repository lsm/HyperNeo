import type { SessionConfig } from '@hyperneo/shared';
import type {
  SessionToolChoiceKey,
  SessionToolSelection,
} from '@hyperneo/shared/types/session-tool-choice';
import { isDeepStrictEqual } from 'node:util';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  projectLegacySessionToolSelection,
  type SessionToolChoiceInput,
} from './session-tool-choice.ts';

export type LegacyToolPreference =
  | { kind: 'skills'; disabledSkills: readonly string[] }
  | { kind: 'mcp'; serverId: string; enabled: boolean | null };
type Failure = {
  ok: false;
  reason: 'missing-definition' | 'ambiguous-alias' | 'selection_version_unsupported';
};
export type LegacyToolPreferenceResult =
  | Failure
  | { ok: true; changes: Array<{ key: SessionToolChoiceKey; selected: boolean }> };
type DefaultEdits = Extract<LegacyToolPreferenceResult, { ok: true }>['changes'];
type DefaultUpdate = { ok: true; selection: SessionToolSelection } | Failure;
function gateDefaults(
  defaults: SessionToolSelection | undefined
): { value: true } | { reason: Failure } {
  return defaults && defaults.version !== 1
    ? { reason: { ok: false, reason: 'selection_version_unsupported' } }
    : { value: true };
}
function translate(
  catalog: SessionToolChoiceInput,
  config: SessionConfig,
  request: LegacyToolPreference,
  defaults: SessionToolSelection | undefined
): LegacyToolPreferenceResult {
  if (request.kind === 'mcp') {
    if (!catalog.registry.some((server) => server.id === request.serverId))
      return { ok: false, reason: 'missing-definition' };
    const inherited =
      defaults ??
      projectLegacySessionToolSelection({
        ...catalog,
        overrides: catalog.overrides.filter(
          (override) => override.scopeType !== 'session' || override.scopeId !== catalog.session.id
        ),
      });
    return {
      ok: true,
      changes: [
        {
          key: `mcp:${request.serverId}`,
          selected: request.enabled ?? !!inherited.choices[`mcp:${request.serverId}`]?.selected,
        },
      ],
    };
  }
  const before = new Set(config.tools?.disabledSkills ?? []);
  const after = new Set(request.disabledSkills);
  const changes = new Map<SessionToolChoiceKey, boolean>();
  for (const id of new Set([...before, ...after])) {
    if (before.has(id) === after.has(id)) continue;
    const skill = catalog.skills.find((entry) => entry.id === id);
    const serverId =
      skill?.sourceType === 'mcp_server' && skill.config.type === 'mcp_server'
        ? skill.config.appMcpServerId
        : undefined;
    if (
      !skill ||
      (serverId !== undefined && !catalog.registry.some((server) => server.id === serverId))
    ) {
      if (after.has(id)) return { ok: false, reason: 'missing-definition' };
      continue;
    }
    const key: SessionToolChoiceKey = serverId !== undefined ? `mcp:${serverId}` : `skill:${id}`;
    const selected = !after.has(id);
    if (changes.has(key) && changes.get(key) !== selected)
      return { ok: false, reason: 'ambiguous-alias' };
    changes.set(key, selected);
  }
  return { ok: true, changes: [...changes].map(([key, selected]) => ({ key, selected })) };
}
export const translateLegacyToolPreference = (
  superpipe({})('translate-legacy-tool-preference') as PipelineAPI
)
  .input(['catalog', 'config', 'request', 'defaults'])
  .pipe(gateDefaults, 'defaults', 'result:translation')
  .pipe(translate, ['catalog', 'config', 'request', 'defaults'], 'translation')
  .end('translation') as (
  catalog: SessionToolChoiceInput,
  config: SessionConfig,
  request: LegacyToolPreference,
  defaults?: SessionToolSelection
) => LegacyToolPreferenceResult;

function updateDefaults(
  before: SessionToolSelection,
  after: SessionToolSelection,
  edits: DefaultEdits,
  defaults: SessionToolSelection | undefined
): DefaultUpdate {
  const requested = new Map(edits.map((edit) => [edit.key, edit]));
  if (requested.size !== edits.length) return { ok: false, reason: 'ambiguous-alias' };
  const original = defaults ?? before;
  const choices = structuredClone(original.choices);
  for (const key of new Set([
    ...Object.keys(before.choices),
    ...Object.keys(after.choices),
    ...requested.keys(),
  ]) as Set<SessionToolChoiceKey>) {
    if (!requested.has(key) && isDeepStrictEqual(before.choices[key], after.choices[key])) continue;
    const old = original.choices[key];
    const next = after.choices[key];
    choices[key] = {
      selected:
        requested.get(key)?.selected ??
        (before.choices[key]?.selected !== next?.selected
          ? (next?.selected ?? false)
          : (old?.selected ?? false)),
      aliases: [...(old?.aliases?.length ? old.aliases : (next?.aliases ?? []))],
    };
  }
  return { ok: true, selection: { version: 1, choices } };
}
export const projectLegacyToolDefaultUpdate = (
  superpipe({})('project-legacy-tool-default-update') as PipelineAPI
)
  .input(['before', 'after', 'edits', 'defaults'])
  .pipe(gateDefaults, 'defaults', 'result:update')
  .pipe(projectLegacySessionToolSelection, 'before', 'old')
  .pipe(projectLegacySessionToolSelection, 'after', 'updated')
  .pipe(updateDefaults, ['old', 'updated', 'edits', 'defaults'], 'update')
  .end('update') as (
  before: SessionToolChoiceInput,
  after: SessionToolChoiceInput,
  edits: DefaultEdits,
  defaults?: SessionToolSelection
) => DefaultUpdate;

export function selectSessionToolDefaults(
  session: SessionToolChoiceInput['session'],
  global?: SessionToolSelection,
  space?: { id: string; selection: SessionToolSelection }
): SessionToolSelection | undefined {
  return space && space.id === session.context?.spaceId ? space.selection : global;
}
