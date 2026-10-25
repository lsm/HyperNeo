import { describe, expect, it } from 'bun:test';
import type { AppSkill } from '@hyperneo/shared';
import type { SessionToolSelection } from '@hyperneo/shared/types/session-tool-choice';
import {
  projectSessionToolInputs,
  prepareInitialSessionToolSelection,
} from '../../../../src/lib/tools/session-tool-inputs.ts';
import type { SessionToolChoiceInput } from '../../../../src/lib/tools/session-tool-choice.ts';
import { mergeSessionMcpServers } from '../../../../src/lib/mcp/built-in-servers.ts';

const skill = (id: string, extra: Partial<AppSkill> = {}): AppSkill => ({
  id,
  name: id,
  displayName: id,
  description: '',
  sourceType: 'mcp_server',
  config: { type: 'mcp_server', appMcpServerId: 'browser' },
  enabled: false,
  builtIn: false,
  validationStatus: 'valid',
  createdAt: 1,
  ...extra,
});
const catalog = (extra: Partial<SessionToolChoiceInput> = {}): SessionToolChoiceInput => ({
  session: { id: 'session' },
  registry: [
    {
      id: 'browser',
      name: 'registry-name',
      sourceType: 'stdio',
      command: 'synthetic',
      enabled: false,
    },
  ],
  skills: [
    skill('wrapper'),
    skill('builtin', {
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'builtin' },
    }),
    skill('plugin', {
      sourceType: 'plugin',
      config: { type: 'plugin', pluginPath: '/synthetic/plugin' },
    }),
  ],
  overrides: [],
  ...extra,
});
const defaults = (): SessionToolSelection => ({
  version: 1,
  choices: {
    'mcp:browser': { selected: true, aliases: ['frozen-alias'] },
    'skill:builtin': { selected: true },
    'skill:plugin': { selected: true },
  },
});
function project(input = catalog(), selection = defaults()) {
  const result = projectSessionToolInputs(input, selection);
  if (!result.ok) throw new Error(result.reason);
  return result;
}
function initial(
  input = catalog(),
  vetoes: readonly string[] = [],
  selection: SessionToolSelection | undefined = defaults()
) {
  const result = prepareInitialSessionToolSelection(input, vetoes, selection);
  if (!result.ok) throw new Error(result.reason);
  return result.selection;
}

describe('canonical session tool inputs', () => {
  it('projects selected instructions and frozen MCP aliases despite old global off flags', () => {
    const input = catalog();
    const output = project(input);
    expect(output.instructionSkills.map((entry) => entry.id)).toEqual(['builtin', 'plugin']);
    expect(output.catalogServers).toEqual([{ alias: 'frozen-alias', server: input.registry[0] }]);
    expect(output.choices.filter((choice) => choice.selected).map((choice) => choice.key)).toEqual([
      'mcp:browser',
      'skill:builtin',
      'skill:plugin',
    ]);
    expect(input.skills.every((entry) => !entry.enabled)).toBe(true);
  });
  it('retains frozen aliases after the old wrapper rows are folded away', () => {
    expect(project(catalog({ skills: [] })).catalogServers.map((entry) => entry.alias)).toEqual([
      'frozen-alias',
    ]);
  });
  it('never creates runtime/native tools or replaces reserved built-ins', () => {
    const selection = {
      version: 1 as const,
      choices: { 'mcp:browser': { selected: true, aliases: ['hyperneo-operations'] } },
    };
    const projected = project(catalog(), selection);
    const operation = { type: 'sdk', instance: {} };
    const runtime = { type: 'sdk', instance: {} };
    const merged = mergeSessionMcpServers<unknown>({
      registryServers: Object.fromEntries(
        projected.catalogServers.map(({ alias, server }) => [
          alias,
          { type: 'stdio', command: server.command },
        ])
      ),
      runtimeServers: { runtime },
      operationServer: operation,
    });
    expect(merged.servers['hyperneo-operations']).toBe(operation);
    expect(merged.servers.runtime).toBe(runtime);
    expect(merged.servers['hyperneo-operations-2']).toEqual({
      type: 'stdio',
      command: 'synthetic',
    });
    expect(Object.keys(projected).sort()).toEqual([
      'catalogServers',
      'choices',
      'instructionSkills',
      'ok',
    ]);
  });
  it('returns no executable inputs for off, policy-denied, missing or colliding definitions', () => {
    const input = catalog({ denied: ['skill:builtin'] });
    input.registry = [
      ...input.registry,
      { id: 'other', name: 'other', sourceType: 'stdio', command: 'synthetic', enabled: true },
    ];
    const selection = defaults();
    selection.choices['skill:plugin'] = { selected: false };
    selection.choices['mcp:other'] = { selected: true, aliases: ['frozen-alias'] };
    selection.choices['mcp:missing'] = { selected: true, aliases: ['missing'] };
    const output = project(input, selection);
    expect(output.instructionSkills).toEqual([]);
    expect(output.catalogServers).toEqual([]);
    expect(output.choices.find((choice) => choice.key === 'skill:builtin')?.reason).toBe(
      'policy-denied'
    );
    expect(output.choices.find((choice) => choice.key === 'mcp:missing')?.reason).toBe(
      'missing-definition'
    );
    expect(output.choices.find((choice) => choice.key === 'mcp:browser')?.reason).toBe(
      'ambiguous-alias'
    );
  });
  it('keeps Space-only instructions out of an inbox even with an explicit stored on', () => {
    const input = catalog({
      skills: [
        skill('builtin', {
          sourceType: 'builtin',
          config: { type: 'builtin', commandName: 'builtin', spaceOnly: true },
        }),
      ],
    });
    expect(project(input).instructionSkills).toEqual([]);
    input.session.context = { spaceId: 'space' };
    expect(project(input).instructionSkills.map((entry) => entry.id)).toEqual(['builtin']);
  });
  it('does not turn old session/slot preference vetoes back into gates on an existing canonical selection', () => {
    const output = project(
      catalog({
        disabledSkillIds: ['builtin', 'wrapper'],
        skillOverrides: [{ skillId: 'plugin', enabled: false }],
      })
    );
    expect(output.instructionSkills.map((entry) => entry.id)).toEqual(['builtin', 'plugin']);
    expect(output.catalogServers.map((entry) => entry.alias)).toEqual(['frozen-alias']);
  });
  it('rejects unsupported versions instead of falling back to current catalog defaults', () => {
    const future = { ...defaults(), version: 2 as 1 };
    expect(projectSessionToolInputs(catalog(), future)).toEqual({
      ok: false,
      reason: 'selection_version_unsupported',
    });
    expect(prepareInitialSessionToolSelection(catalog(), [], future)).toEqual({
      ok: false,
      reason: 'selection_version_unsupported',
    });
  });
});

describe('initial session tool defaults', () => {
  it('clones explicit defaults without reapplying old global gates or selecting later catalog additions', () => {
    const input = catalog();
    input.registry = [
      ...input.registry,
      { id: 'new', name: 'new', sourceType: 'stdio', command: 'synthetic', enabled: true },
    ];
    const template = defaults();
    const result = initial(input, [], template);
    expect(result.choices['mcp:browser']).toEqual({ selected: true, aliases: ['frozen-alias'] });
    expect(result.choices['mcp:new']).toBeUndefined();
    result.choices['mcp:browser']!.aliases!.push('changed');
    expect(template.choices['mcp:browser']?.aliases).toEqual(['frozen-alias']);
  });
  it('applies explicit initial vetoes plus captured session and slot vetoes to new defaults only', () => {
    const input = catalog({
      disabledSkillIds: ['builtin'],
      skillOverrides: [{ skillId: 'plugin', enabled: false }],
    });
    const selection = initial(input, ['wrapper']);
    expect(Object.values(selection.choices).map((choice) => choice?.selected)).toEqual([
      false,
      false,
      false,
    ]);
    expect(selection.choices['mcp:browser']?.aliases).toEqual(['frozen-alias']);
    expect(defaults().choices['mcp:browser']?.selected).toBe(true);
  });
  it('preserves allowed aliases when one of several legacy wrappers is vetoed', () => {
    const input = catalog({ skills: [skill('one'), skill('two')] });
    const template = {
      version: 1 as const,
      choices: { 'mcp:browser': { selected: true, aliases: ['one', 'two'] } },
    };
    expect(initial(input, ['one'], template).choices['mcp:browser']).toEqual({
      selected: true,
      aliases: ['two'],
    });
    expect(initial(input, ['one', 'two'], template).choices['mcp:browser']).toEqual({
      selected: false,
      aliases: ['one', 'two'],
    });
  });
  it('does not guess that an unmapped old alias is the unvetoed wrapper', () => {
    const input = catalog({ skills: [skill('one'), skill('two')] });
    const template = {
      version: 1 as const,
      choices: { 'mcp:browser': { selected: true, aliases: ['old-one', 'old-two'] } },
    };
    expect(initial(input, ['one'], template).choices['mcp:browser']?.selected).toBe(false);
  });
  it('falls back to the old effective preferences only when no canonical defaults exist', () => {
    const result = prepareInitialSessionToolSelection(catalog(), []);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.selection.choices['mcp:browser']).toEqual({
      selected: false,
      aliases: ['wrapper'],
    });
    const input = catalog({
      registry: [{ ...catalog().registry[0], enabled: true }],
      skills: [{ ...skill('wrapper'), enabled: true }],
    });
    const vetoed = prepareInitialSessionToolSelection(input, ['wrapper']);
    expect(vetoed.ok).toBe(true);
    if (!vetoed.ok) throw new Error(vetoed.reason);
    expect(vetoed.selection.choices['mcp:browser']?.selected).toBe(false);
  });
  it('keeps invalid, missing and policy-restricted defaults unselected without copying transport secrets', () => {
    const input = catalog({ denied: ['mcp:browser'] });
    input.registry = [
      { ...input.registry[0], env: { PRIVATE: 'secret' }, headers: { Authorization: 'secret' } },
    ];
    const template = defaults();
    template.choices['mcp:missing'] = { selected: true, aliases: ['old'] };
    const selection = initial(input, [], template);
    expect(selection.choices['mcp:browser']?.selected).toBe(false);
    expect(selection.choices['mcp:missing']?.selected).toBe(false);
    expect(JSON.stringify(selection)).not.toMatch(
      /secret|PRIVATE|Authorization|synthetic\/plugin|command/
    );
  });
});
