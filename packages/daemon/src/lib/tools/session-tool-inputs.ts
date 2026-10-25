import type { AppMcpServer, AppSkill } from '@hyperneo/shared';
import type {
  ResolvedSessionToolChoice,
  SessionToolChoiceKey,
  SessionToolSelection,
} from '@hyperneo/shared/types/session-tool-choice';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  projectLegacySessionToolSelection,
  resolveSessionToolChoices,
  type SessionToolChoiceInput,
} from './session-tool-choice.ts';

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
type SelectionGate = { value: SessionToolSelection } | { reason: Unsupported };

function gateVersion(selection: SessionToolSelection): SelectionGate {
  return selection.version === 1
    ? { value: selection }
    : { reason: { ok: false, reason: 'selection_version_unsupported' } };
}
function projectInputs(
  catalog: SessionToolChoiceInput,
  choices: ResolvedSessionToolChoice[]
): Extract<SessionToolInputs, { ok: true }> {
  const byKey = new Map(choices.map((choice) => [choice.key, choice]));
  return {
    ok: true,
    instructionSkills: catalog.skills.filter(
      (skill) => skill.sourceType !== 'mcp_server' && byKey.get(`skill:${skill.id}`)?.selected
    ),
    catalogServers: catalog.registry.flatMap((server) => {
      const choice = byKey.get(`mcp:${server.id}`);
      return choice?.selected ? choice.aliases.map((alias) => ({ alias, server })) : [];
    }),
    choices,
  };
}

export const projectSessionToolInputs = (
  superpipe({})('project-session-tool-inputs') as PipelineAPI
)
  .input(['catalog', 'selection'])
  .pipe(gateVersion, 'selection', 'result:projection')
  .pipe(resolveSessionToolChoices, ['catalog', 'projection'], 'choices')
  .pipe(projectInputs, ['catalog', 'choices'], 'projection')
  .end('projection') as (
  catalog: SessionToolChoiceInput,
  selection: SessionToolSelection
) => SessionToolInputs;

function chooseDefaults(
  catalog: SessionToolChoiceInput,
  initialVetoes: readonly string[],
  defaults: SessionToolSelection | undefined
): SelectionGate {
  return gateVersion(
    defaults ??
      projectLegacySessionToolSelection({
        ...catalog,
        disabledSkillIds: [...(catalog.disabledSkillIds ?? []), ...initialVetoes],
      })
  );
}
function applyInitialVetoes(
  catalog: SessionToolChoiceInput,
  initialVetoes: readonly string[],
  selection: SessionToolSelection
): SessionToolSelection {
  const vetoes = new Set([
    ...(catalog.disabledSkillIds ?? []),
    ...initialVetoes,
    ...(catalog.skillOverrides ?? [])
      .filter((override) => !override.enabled)
      .map((override) => override.skillId),
  ]);
  const affected = new Set(
    catalog.skills
      .filter((skill) => vetoes.has(skill.id))
      .map((skill) =>
        skill.sourceType === 'mcp_server' && skill.config.type === 'mcp_server'
          ? `mcp:${skill.config.appMcpServerId}`
          : `skill:${skill.id}`
      )
  );
  const allowed = projectLegacySessionToolSelection({
    ...catalog,
    disabledSkillIds: [...vetoes],
    skills: catalog.skills.map((skill) => ({ ...skill, enabled: true })),
    registry: catalog.registry.map((server) => ({ ...server, enabled: true })),
    overrides: [],
  });
  return {
    version: 1,
    choices: Object.fromEntries(
      Object.entries(selection.choices).flatMap(([key, choice]) => {
        if (!choice) return [];
        let selected = choice.selected;
        let aliases = [...(choice.aliases ?? [])];
        if (affected.has(key)) {
          const permitted = allowed.choices[key as SessionToolChoiceKey];
          const remaining = aliases.length
            ? aliases.filter((alias) => permitted?.aliases?.includes(alias))
            : permitted?.aliases?.length === 1
              ? permitted.aliases
              : [];
          selected = selected && !!permitted?.selected && remaining.length > 0;
          if (selected) aliases = [...remaining];
        }
        return [[key, { selected, aliases }]];
      })
    ),
  };
}
function normalizeInitial(
  catalog: SessionToolChoiceInput,
  selection: SessionToolSelection
): Extract<InitialSessionToolSelection, { ok: true }> {
  const choices = new Map(
    resolveSessionToolChoices(catalog, selection).map((choice) => [choice.key, choice])
  );
  return {
    ok: true,
    selection: {
      version: 1,
      choices: Object.fromEntries(
        Object.entries(selection.choices).flatMap(([key, choice]) => {
          if (!choice) return [];
          const resolved = choices.get(key as SessionToolChoiceKey);
          const aliases = choice.aliases?.length
            ? choice.aliases
            : resolved?.aliases.length === 1
              ? resolved.aliases
              : [];
          return [[key, { selected: resolved?.selected ?? false, aliases: [...aliases] }]];
        })
      ),
    },
  };
}

export const prepareInitialSessionToolSelection = (
  superpipe({})('prepare-initial-session-tool-selection') as PipelineAPI
)
  .input(['catalog', 'initialVetoes', 'defaults'])
  .pipe(chooseDefaults, ['catalog', 'initialVetoes', 'defaults'], 'result:initial')
  .pipe(applyInitialVetoes, ['catalog', 'initialVetoes', 'initial'], 'initial')
  .pipe(normalizeInitial, ['catalog', 'initial'], 'initial')
  .end('initial') as (
  catalog: SessionToolChoiceInput,
  initialVetoes: readonly string[],
  defaults?: SessionToolSelection
) => InitialSessionToolSelection;
