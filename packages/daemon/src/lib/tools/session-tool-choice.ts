import type {
  AppMcpServer,
  AppSkill,
  McpEnablementOverride,
  SkillEnablementOverride,
} from '@hyperneo/shared';
import type {
  ResolvedSessionToolChoice,
  SessionToolChoiceKey,
  SessionToolSelection,
} from '@hyperneo/shared/types/session-tool-choice';
import superpipe, { type PipelineAPI } from 'superpipe';
import { resolveMcpServers, type ResolveMcpServersSession } from '../mcp/resolve-mcp-servers.ts';

export function assertNoToolSelectionDefaults(config: object | null | undefined): void {
  if (config && Object.hasOwn(config, 'toolSelectionDefaults'))
    throw new Error('toolSelectionDefaults is daemon-owned and cannot be supplied in settings');
}

export interface SessionToolChoiceInput {
  session: ResolveMcpServersSession;
  skills: readonly AppSkill[];
  registry: readonly AppMcpServer[];
  overrides: readonly McpEnablementOverride[];
  disabledSkillIds?: readonly string[];
  skillOverrides?: readonly SkillEnablementOverride[];
  denied?: readonly SessionToolChoiceKey[];
}

interface Definition {
  key: SessionToolChoiceKey;
  exists: boolean;
  spaceOnly: boolean;
  aliases: string[];
  legacyAliases: string[];
  legacySelected: boolean;
}

function definitions(input: SessionToolChoiceInput): Definition[] {
  const enabled = new Set(
    resolveMcpServers(input.session, input.registry, input.overrides).map((server) => server.id)
  );
  const skillOn = (skill: AppSkill) =>
    skill.enabled &&
    !input.disabledSkillIds?.includes(skill.id) &&
    !input.skillOverrides?.some((override) => override.skillId === skill.id && !override.enabled);
  const wrappers = input.skills.filter(
    (skill) => skill.sourceType === 'mcp_server' && skill.config.type === 'mcp_server'
  );
  const ids = new Set([
    ...input.registry.map((server) => server.id),
    ...wrappers.flatMap((skill) =>
      skill.config.type === 'mcp_server' ? [skill.config.appMcpServerId] : []
    ),
  ]);
  const servers: Definition[] = [...ids].map((id) => {
    const server = input.registry.find((entry) => entry.id === id);
    const linked = wrappers.filter(
      (skill) => skill.config.type === 'mcp_server' && skill.config.appMcpServerId === id
    );
    const aliases = linked.length ? linked.map((skill) => skill.name) : server ? [server.name] : [];
    const legacyAliases = linked.length
      ? linked.filter(skillOn).map((skill) => skill.name)
      : aliases;
    return {
      key: `mcp:${id}`,
      exists: !!server,
      spaceOnly: false,
      aliases,
      legacyAliases,
      legacySelected: enabled.has(id) && legacyAliases.length > 0,
    };
  });
  return servers.concat(
    input.skills
      .filter((skill) => !wrappers.includes(skill))
      .map((skill) => {
        const spaceOnly = skill.config.type === 'builtin' && !!skill.config.spaceOnly;
        const exists =
          (skill.sourceType === 'builtin' && skill.config.type === 'builtin') ||
          (skill.sourceType === 'plugin' && skill.config.type === 'plugin');
        return {
          key: `skill:${skill.id}` as SessionToolChoiceKey,
          exists,
          spaceOnly,
          aliases: [],
          legacyAliases: [],
          legacySelected:
            exists && skillOn(skill) && (!spaceOnly || !!input.session.context?.spaceId),
        };
      })
  );
}

function snapshot(defs: Definition[]): SessionToolSelection {
  return {
    version: 1,
    choices: Object.fromEntries(
      defs.map((def) => [
        def.key,
        {
          selected: def.legacySelected,
          aliases: [
            ...new Set(
              def.legacySelected ? def.legacyAliases : def.aliases.length === 1 ? def.aliases : []
            ),
          ],
        },
      ])
    ),
  };
}

function resolveChoices(
  input: SessionToolChoiceInput,
  selection: SessionToolSelection,
  defs: Definition[]
): ResolvedSessionToolChoice[] {
  const known = new Set(defs.map((def) => def.key));
  const missing = (Object.keys(selection.choices) as SessionToolChoiceKey[])
    .filter((key) => !known.has(key))
    .map((key) => ({ key, exists: false, spaceOnly: false, aliases: [] }));
  return [...defs, ...missing].map((def) => {
    const saved = selection.choices[def.key];
    const aliases = [...new Set(saved?.aliases?.length ? saved.aliases : def.aliases)];
    const reason: ResolvedSessionToolChoice['reason'] = !def.exists
      ? 'missing-definition'
      : input.denied?.includes(def.key)
        ? 'policy-denied'
        : def.spaceOnly && !input.session.context?.spaceId
          ? 'space-required'
          : !saved?.selected
            ? 'off'
            : def.key.startsWith('mcp:') &&
                (!aliases.length || (!saved.aliases?.length && aliases.length !== 1))
              ? 'ambiguous-alias'
              : 'selected';
    return { key: def.key, aliases, reason, selected: reason === 'selected' };
  });
}

function rejectAliasCollisions(choices: ResolvedSessionToolChoice[]): ResolvedSessionToolChoice[] {
  const counts = new Map<string, number>();
  for (const choice of choices.filter((entry) => entry.selected && entry.key.startsWith('mcp:')))
    for (const alias of choice.aliases) counts.set(alias, (counts.get(alias) ?? 0) + 1);
  return choices.map((choice) =>
    choice.selected &&
    choice.key.startsWith('mcp:') &&
    choice.aliases.some((alias) => counts.get(alias)! > 1)
      ? { ...choice, selected: false, reason: 'ambiguous-alias' }
      : choice
  );
}

export const projectLegacySessionToolSelection = (
  superpipe({})('project-legacy-session-tool-selection') as PipelineAPI
)
  .input(['input'])
  .pipe(definitions, 'input', 'definitions')
  .pipe(snapshot, 'definitions', 'selection')
  .end('selection') as (input: SessionToolChoiceInput) => SessionToolSelection;

export const resolveSessionToolChoices = (
  superpipe({})('resolve-session-tool-choices') as PipelineAPI
)
  .input(['input', 'selection'])
  .pipe(definitions, 'input', 'definitions')
  .pipe(resolveChoices, ['input', 'selection', 'definitions'], 'choices')
  .pipe(rejectAliasCollisions, 'choices', 'resolved')
  .end('resolved') as (
  input: SessionToolChoiceInput,
  selection: SessionToolSelection
) => ResolvedSessionToolChoice[];
