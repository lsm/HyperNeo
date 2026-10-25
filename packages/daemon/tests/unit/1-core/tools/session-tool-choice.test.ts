import { describe, expect, it } from 'bun:test';
import type { AppMcpServer, AppSkill } from '@hyperneo/shared';
import {
  projectLegacySessionToolSelection,
  resolveSessionToolChoices,
  type SessionToolChoiceInput,
} from '../../../../src/lib/tools/session-tool-choice.ts';

const server = (id = 'browser', extra: Partial<AppMcpServer> = {}): AppMcpServer => ({
  id,
  name: id,
  enabled: true,
  source: 'builtin',
  sourceType: 'stdio',
  command: 'synthetic',
  ...extra,
});
const skill = (id = 'wrapper', extra: Partial<AppSkill> = {}): AppSkill => ({
  id,
  name: id,
  displayName: id,
  description: '',
  sourceType: 'mcp_server',
  config: { type: 'mcp_server', appMcpServerId: 'browser' },
  enabled: true,
  builtIn: false,
  validationStatus: 'valid',
  createdAt: 0,
  ...extra,
});
const input = (extra: Partial<SessionToolChoiceInput> = {}): SessionToolChoiceInput => ({
  session: { id: 'session', context: { spaceId: 'space' } },
  skills: [skill()],
  registry: [server()],
  overrides: [],
  ...extra,
});
const resolve = (fixture: SessionToolChoiceInput) =>
  resolveSessionToolChoices(fixture, projectLegacySessionToolSelection(fixture));

describe('session tool choices', () => {
  it('keeps server-on/skill-off off and folds the wrapper into one backing-server choice', () => {
    const fixture = input({ skills: [skill('wrapper', { enabled: false })] });
    const snapshot = projectLegacySessionToolSelection(fixture);
    expect(snapshot.choices).toEqual({ 'mcp:browser': { selected: false, aliases: ['wrapper'] } });
    expect(resolve(fixture)).toEqual([
      { key: 'mcp:browser', selected: false, aliases: ['wrapper'], reason: 'off' },
    ]);
  });

  it('preserves legacy SDK names rather than replacing wrapper aliases with registry names', () => {
    const fixture = input({ registry: [server(), server('plain')] });
    expect(resolve(fixture)).toEqual([
      { key: 'mcp:browser', selected: true, aliases: ['wrapper'], reason: 'selected' },
      { key: 'mcp:plain', selected: true, aliases: ['plain'], reason: 'selected' },
    ]);
  });

  it('projects session then Space then registry MCP precedence and ignores unrelated overrides', () => {
    const fixture = input({
      registry: [server('browser', { enabled: false })],
      overrides: [
        { scopeType: 'space', scopeId: 'space', serverId: 'browser', enabled: false },
        { scopeType: 'session', scopeId: 'session', serverId: 'browser', enabled: true },
        { scopeType: 'session', scopeId: 'other', serverId: 'browser', enabled: false },
      ],
    });
    expect(resolve(fixture)[0].selected).toBe(true);
    fixture.overrides = fixture.overrides.filter((override) => override.scopeType !== 'session');
    expect(resolve(fixture)[0].selected).toBe(false);
    fixture.overrides = [
      { scopeType: 'space', scopeId: 'space', serverId: 'browser', enabled: true },
    ];
    expect(resolve(fixture)[0].selected).toBe(true);
    fixture.session = { id: 'session' };
    expect(resolve(fixture)[0].selected).toBe(false);
  });

  it('materializes global, session and slot skill vetoes without allowing legacy enable overrides', () => {
    for (const extra of [
      { disabledSkillIds: ['wrapper'] },
      { skillOverrides: [{ skillId: 'wrapper', enabled: false }] },
      {
        skills: [skill('wrapper', { enabled: false })],
        skillOverrides: [{ skillId: 'wrapper', enabled: true }],
      },
    ])
      expect(resolve(input(extra))[0].selected).toBe(false);
  });

  it('projects builtin/plugin instruction choices separately from folded MCP skills', () => {
    const fixture = input({
      skills: [
        skill(),
        skill('instructions', {
          sourceType: 'builtin',
          config: { type: 'builtin', commandName: 'instructions' },
        }),
        skill('plugin', {
          sourceType: 'plugin',
          config: { type: 'plugin', pluginPath: '/synthetic/plugin' },
        }),
      ],
    });
    const snapshot = projectLegacySessionToolSelection(fixture);
    expect(snapshot.choices['skill:instructions']).toEqual({ selected: true, aliases: [] });
    expect(snapshot.choices['skill:plugin']).toEqual({ selected: true, aliases: [] });
    expect(snapshot.choices['skill:wrapper']).toBeUndefined();
  });

  it('keeps a saved selection independent of later global-default edits and newly installed tools', () => {
    const fixture = input();
    const snapshot = projectLegacySessionToolSelection(fixture);
    const changed = input({
      skills: [skill('wrapper', { enabled: false })],
      registry: [server('browser', { enabled: false }), server('new-tool')],
    });
    const choices = resolveSessionToolChoices(changed, snapshot);
    expect(choices.find((choice) => choice.key === 'mcp:browser')?.selected).toBe(true);
    expect(choices.find((choice) => choice.key === 'mcp:new-tool')?.selected).toBe(false);
    expect(projectLegacySessionToolSelection(changed).choices['mcp:new-tool']?.selected).toBe(true);
  });

  it('allows an explicit canonical choice despite legacy global/session/slot off flags', () => {
    const fixture = input({
      skills: [skill('wrapper', { enabled: false })],
      registry: [server('browser', { enabled: false })],
      disabledSkillIds: ['wrapper'],
      skillOverrides: [{ skillId: 'wrapper', enabled: false }],
    });
    const snapshot = { version: 1 as const, choices: { 'mcp:browser': { selected: true } } };
    expect(resolveSessionToolChoices(fixture, snapshot)[0]).toEqual({
      key: 'mcp:browser',
      selected: true,
      aliases: ['wrapper'],
      reason: 'selected',
    });
    fixture.denied = ['mcp:browser'];
    expect(resolveSessionToolChoices(fixture, snapshot)[0].reason).toBe('policy-denied');
    expect(resolveSessionToolChoices(fixture, snapshot)[0].selected).toBe(false);
    expect(snapshot.choices['mcp:browser'].selected).toBe(true);
  });

  it('preserves explicit offs and never falls back to global-on for an absent saved entry', () => {
    const fixture = input();
    expect(resolveSessionToolChoices(fixture, { version: 1, choices: {} })[0].selected).toBe(false);
    const snapshot = { version: 1 as const, choices: { 'mcp:browser': { selected: false } } };
    expect(resolveSessionToolChoices(fixture, snapshot)[0].selected).toBe(false);
  });

  it('keeps Space-only instruction requirements authoritative', () => {
    const scoped = skill('coordination', {
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'coordination', spaceOnly: true },
    });
    const fixture = input({ session: { id: 'session' }, skills: [scoped], registry: [] });
    expect(projectLegacySessionToolSelection(fixture).choices['skill:coordination']?.selected).toBe(
      false
    );
    const snapshot = { version: 1 as const, choices: { 'skill:coordination': { selected: true } } };
    expect(resolveSessionToolChoices(fixture, snapshot)[0].reason).toBe('space-required');
    fixture.session.context = { spaceId: 'space' };
    expect(resolveSessionToolChoices(fixture, snapshot)[0].selected).toBe(true);
  });

  it('retains missing backing definitions and unknown saved keys as unselected with a reason', () => {
    const fixture = input({ registry: [] });
    const snapshot = projectLegacySessionToolSelection(fixture);
    snapshot.choices['mcp:deleted'] = { selected: true, aliases: ['old-name'] };
    expect(
      resolveSessionToolChoices(fixture, snapshot).every(
        (choice) => !choice.selected && choice.reason === 'missing-definition'
      )
    ).toBe(true);
    expect(resolveSessionToolChoices(fixture, snapshot).map((choice) => choice.key)).toEqual([
      'mcp:browser',
      'mcp:deleted',
    ]);
  });

  it('requires an unambiguous alias for a newly enabled multiply-wrapped server', () => {
    const fixture = input({
      skills: [skill('first', { enabled: false }), skill('second', { enabled: false })],
    });
    const snapshot = { version: 1 as const, choices: { 'mcp:browser': { selected: true } } };
    expect(resolveSessionToolChoices(fixture, snapshot)[0].reason).toBe('ambiguous-alias');
    expect(resolveSessionToolChoices(fixture, snapshot)[0].selected).toBe(false);
  });

  it('preserves the exact legacy alias set and stored aliases after wrapper metadata is folded away', () => {
    const fixture = input({ skills: [skill('first'), skill('second')] });
    const snapshot = projectLegacySessionToolSelection(fixture);
    expect(resolveSessionToolChoices(fixture, snapshot)[0].aliases).toEqual(['first', 'second']);
    fixture.skills = [];
    expect(resolveSessionToolChoices(fixture, snapshot)[0].aliases).toEqual(['first', 'second']);
  });

  it('fails closed instead of picking a winner when selected server aliases collide', () => {
    const fixture = input({ registry: [server('one'), server('two')], skills: [] });
    const result = resolveSessionToolChoices(fixture, {
      version: 1,
      choices: {
        'mcp:one': { selected: true, aliases: ['same-name'] },
        'mcp:two': { selected: true, aliases: ['same-name'] },
      },
    });
    expect(result.map((choice) => choice.key)).toEqual(['mcp:one', 'mcp:two']);
    expect(result.every((choice) => !choice.selected && choice.reason === 'ambiguous-alias')).toBe(
      true
    );
  });

  it('does not share mutable aliases or serialize transport configuration in resolved choices', () => {
    const fixture = input({
      registry: [
        server('browser', { env: { KEY: 'PRIVATE' }, headers: { Authorization: 'PRIVATE' } }),
      ],
    });
    const snapshot = projectLegacySessionToolSelection(fixture);
    const result = resolveSessionToolChoices(fixture, snapshot);
    result[0].aliases.push('changed');
    expect(snapshot.choices['mcp:browser']?.aliases).toEqual(['wrapper']);
    expect(JSON.stringify(resolveSessionToolChoices(fixture, snapshot))).not.toMatch(
      /PRIVATE|Authorization|command|headers|env/
    );
  });
});
