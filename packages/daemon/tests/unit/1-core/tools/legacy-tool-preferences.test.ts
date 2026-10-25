import { afterEach, describe, expect, it } from 'bun:test';
import type { AppSkill, SessionConfig } from '@hyperneo/shared';
import type { SessionToolSelection } from '@hyperneo/shared/types/session-tool-choice';
import {
  translateLegacyToolPreference,
  projectLegacyToolDefaultUpdate,
} from '../../../../src/lib/tools/legacy-tool-preferences.ts';
import type { SessionToolChoiceInput } from '../../../../src/lib/tools/session-tool-choice.ts';
import {
  changeSessionToolChoice,
  type SessionToolChoiceChangeDependencies,
} from '../../../../src/lib/tools/change-session-tool-choice.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import { createTestSession } from '../../../helpers/database.ts';

const skill = (id: string, mcp = false): AppSkill => ({
  id,
  name: id,
  displayName: id,
  description: '',
  sourceType: mcp ? 'mcp_server' : 'builtin',
  config: mcp
    ? { type: 'mcp_server', appMcpServerId: 'browser' }
    : { type: 'builtin', commandName: id },
  enabled: true,
  builtIn: false,
  validationStatus: 'valid',
  createdAt: 1,
});
const catalog = (extra: Partial<SessionToolChoiceInput> = {}): SessionToolChoiceInput => ({
  session: { id: 'fixture' },
  skills: [skill('notes'), skill('wrapper', true)],
  registry: [
    { id: 'browser', name: 'browser', sourceType: 'stdio', command: 'synthetic', enabled: true },
  ],
  overrides: [],
  ...extra,
});
const selection = (): SessionToolSelection => ({
  version: 1,
  choices: {
    'skill:notes': { selected: false },
    'mcp:browser': { selected: false, aliases: ['frozen-browser'] },
  },
});
const config = (disabledSkills: string[] = []): SessionConfig => ({
  model: 'haiku',
  tools: { disabledSkills },
  toolSelection: selection(),
});
function translated(
  request: Parameters<typeof translateLegacyToolPreference>[2],
  input = catalog(),
  settings = config(),
  defaults?: SessionToolSelection
) {
  const result = translateLegacyToolPreference(input, settings, request, defaults);
  if (!result.ok) throw new Error(result.reason);
  return result.changes;
}

describe('legacy tool preference translation', () => {
  it('translates only changed skill IDs and folds wrappers despite old global off', () => {
    const input = catalog();
    input.skills = input.skills.map((entry) => ({ ...entry, enabled: false }));
    expect(
      translated({ kind: 'skills', disabledSkills: [] }, input, config(['notes', 'wrapper']))
    ).toEqual([
      { key: 'skill:notes', selected: true },
      { key: 'mcp:browser', selected: true },
    ]);
    expect(translated({ kind: 'skills', disabledSkills: ['notes'] }, input)).toEqual([
      { key: 'skill:notes', selected: false },
    ]);
    expect(translated({ kind: 'skills', disabledSkills: [] }, input)).toEqual([]);
  });
  it('refuses an edited unknown skill', () => {
    expect(
      translateLegacyToolPreference(catalog(), config(), {
        kind: 'skills',
        disabledSkills: ['gone'],
      })
    ).toEqual({ ok: false, reason: 'missing-definition' });
  });
  it('coalesces matching wrapper changes and refuses contradictory changes to one row', () => {
    const input = catalog({ skills: [skill('one', true), skill('two', true)] });
    expect(translated({ kind: 'skills', disabledSkills: ['one', 'two'] }, input)).toEqual([
      { key: 'mcp:browser', selected: false },
    ]);
    expect(
      translateLegacyToolPreference(input, config(['one']), {
        kind: 'skills',
        disabledSkills: ['two'],
      })
    ).toEqual({ ok: false, reason: 'ambiguous-alias' });
  });
  it('maps an explicit MCP override independently of the wrapper gate', () => {
    const input = catalog({ skills: [{ ...skill('wrapper', true), enabled: false }] });
    expect(translated({ kind: 'mcp', serverId: 'browser', enabled: true }, input)).toEqual([
      { key: 'mcp:browser', selected: true },
    ]);
    expect(translated({ kind: 'mcp', serverId: 'browser', enabled: false }, input)).toEqual([
      { key: 'mcp:browser', selected: false },
    ]);
    expect(
      translateLegacyToolPreference(input, config(), {
        kind: 'mcp',
        serverId: 'gone',
        enabled: true,
      })
    ).toEqual({ ok: false, reason: 'missing-definition' });
  });
  it('clears to supplied scope defaults, including explicit off and absent keys', () => {
    const defaults = selection();
    defaults.choices['mcp:browser']!.selected = true;
    expect(
      translated({ kind: 'mcp', serverId: 'browser', enabled: null }, catalog(), config(), defaults)
    ).toEqual([{ key: 'mcp:browser', selected: true }]);
    expect(
      translated(
        { kind: 'mcp', serverId: 'browser', enabled: null },
        catalog(),
        config(),
        selection()
      )
    ).toEqual([{ key: 'mcp:browser', selected: false }]);
    expect(
      translated({ kind: 'mcp', serverId: 'browser', enabled: null }, catalog(), config(), {
        version: 1,
        choices: {},
      })
    ).toEqual([{ key: 'mcp:browser', selected: false }]);
  });
  it('without defaults clears the current session override and retains Space precedence', () => {
    const input = catalog({
      session: { id: 'fixture', context: { spaceId: 'space' } },
      overrides: [
        {
          id: 'one',
          scopeType: 'session',
          scopeId: 'fixture',
          serverId: 'browser',
          enabled: false,
        },
        { id: 'two', scopeType: 'space', scopeId: 'space', serverId: 'browser', enabled: true },
      ],
    });
    expect(translated({ kind: 'mcp', serverId: 'browser', enabled: null }, input)).toEqual([
      { key: 'mcp:browser', selected: true },
    ]);
    input.overrides = input.overrides.map((entry) =>
      entry.scopeType === 'space' ? { ...entry, enabled: false } : entry
    );
    expect(translated({ kind: 'mcp', serverId: 'browser', enabled: null }, input)).toEqual([
      { key: 'mcp:browser', selected: false },
    ]);
  });
  it('does not reinterpret unsupported inherited defaults', () => {
    expect(
      translateLegacyToolPreference(
        catalog(),
        config(),
        { kind: 'mcp', serverId: 'browser', enabled: null },
        { ...selection(), version: 2 as 1 }
      )
    ).toEqual({ ok: false, reason: 'selection_version_unsupported' });
  });
});

describe('legacy default edits', () => {
  it('updates changed defaults while preserving aliases and unrelated explicit offs', () => {
    const before = catalog();
    const after = catalog({ registry: [{ ...before.registry[0], enabled: false }] });
    const previous = selection();
    previous.choices['mcp:browser']!.selected = true;
    expect(projectLegacyToolDefaultUpdate(before, after, previous)).toEqual({
      ok: true,
      selection: selection(),
    });
    expect(previous.choices['mcp:browser']?.selected).toBe(true);
  });
  it('adds new defaults without rewriting existing choices', () => {
    const before = catalog();
    const after = catalog({ skills: [...before.skills, skill('new')] });
    const result = projectLegacyToolDefaultUpdate(before, after, selection());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.selection.choices['skill:new']?.selected).toBe(true);
    expect(result.selection.choices['skill:notes']?.selected).toBe(false);
  });
  it('marks removed definitions off retaining aliases, and uses legacy projection only on first use', () => {
    const before = catalog();
    const after = catalog({ registry: [], skills: [skill('notes')] });
    const previous = selection();
    previous.choices['mcp:browser']!.selected = true;
    const result = projectLegacyToolDefaultUpdate(before, after, previous);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.selection.choices['mcp:browser']).toEqual({
      selected: false,
      aliases: ['frozen-browser'],
    });
    const initial = projectLegacyToolDefaultUpdate(before, before);
    expect(initial.ok).toBe(true);
    if (!initial.ok) throw new Error(initial.reason);
    expect(initial.selection.choices['skill:notes']?.selected).toBe(true);
  });
  it('preserves frozen aliases on rename and refuses unknown default versions', () => {
    const before = catalog();
    const after = catalog({
      skills: [skill('notes'), { ...skill('wrapper', true), name: 'renamed' }],
    });
    expect(projectLegacyToolDefaultUpdate(before, after, selection())).toEqual({
      ok: true,
      selection: selection(),
    });
    expect(
      projectLegacyToolDefaultUpdate(before, after, { ...selection(), version: 2 as 1 })
    ).toEqual({ ok: false, reason: 'selection_version_unsupported' });
  });
});
let db: Database | undefined;
afterEach(() => db?.close());
function database() {
  db = new Database(':memory:');
  createTables(db);
  const repo = new SessionRepository(db);
  repo.createSession({
    ...createTestSession('fixture'),
    config: { ...createTestSession('fixture').config, ...config(['notes', 'wrapper']) },
  });
  let commits = 0;
  const deps: SessionToolChoiceChangeDependencies = {
    capture: (id) => repo.captureSessionRuntimeSettings(id),
    catalog: () => catalog(),
    pinnedSlotVetoes: () => [],
    commit: async (snapshot, patch) => {
      commits++;
      return repo.casSessionRuntimeSettings(snapshot, patch);
    },
  };
  return { repo, deps, commits: () => commits };
}
describe('atomic legacy choice batches', () => {
  it('saves multiple choices with one CAS retaining aliases and other settings', async () => {
    const { repo, deps, commits } = database();
    const changes = translated(
      { kind: 'skills', disabledSkills: [] },
      catalog(),
      config(['notes', 'wrapper'])
    );
    const result = await changeSessionToolChoice({ sessionId: 'fixture', changes }, deps);
    expect(result.ok).toBe(true);
    expect(commits()).toBe(1);
    expect(repo.getSession('fixture')!.config.toolSelection?.choices).toEqual({
      'skill:notes': { selected: true, aliases: [] },
      'mcp:browser': { selected: true, aliases: ['frozen-browser'] },
    });
    expect(repo.getSession('fixture')!.config.tools).toEqual(config(['notes', 'wrapper']).tools);
  });
  it('rejects the entire batch if one requested tool is denied', async () => {
    const { repo, deps, commits } = database();
    const before = repo.getSession('fixture')!.config;
    deps.catalog = () => catalog({ denied: ['mcp:browser'] });
    expect(
      await changeSessionToolChoice(
        {
          sessionId: 'fixture',
          changes: [
            { key: 'skill:notes', selected: true },
            { key: 'mcp:browser', selected: true },
          ],
        },
        deps
      )
    ).toEqual({ ok: false, reason: 'policy-denied' });
    expect(commits()).toBe(0);
    expect(repo.getSession('fixture')!.config).toEqual(before);
  });
  it('validates final aliases so a handoff can disable one server and enable another', async () => {
    const { repo, deps } = database();
    repo.updateSession('fixture', {
      config: {
        ...repo.getSession('fixture')!.config,
        toolSelection: {
          version: 1,
          choices: {
            'mcp:browser': { selected: true, aliases: ['shared'] },
            'mcp:other': { selected: false, aliases: ['shared'] },
          },
        },
      },
    });
    deps.catalog = () => {
      const value = catalog();
      return {
        ...value,
        registry: [...value.registry, { ...value.registry[0], id: 'other', name: 'other' }],
      };
    };
    expect(
      (
        await changeSessionToolChoice(
          {
            sessionId: 'fixture',
            changes: [
              { key: 'mcp:other', selected: true },
              { key: 'mcp:browser', selected: false },
            ],
          },
          deps
        )
      ).ok
    ).toBe(true);
    expect(repo.getSession('fixture')!.config.toolSelection?.choices['mcp:other']?.selected).toBe(
      true
    );
    expect(repo.getSession('fixture')!.config.toolSelection?.choices['mcp:browser']?.selected).toBe(
      false
    );
  });
  it('refuses duplicate targets and never retries a superseded batch', async () => {
    const { repo, deps, commits } = database();
    expect(
      await changeSessionToolChoice(
        {
          sessionId: 'fixture',
          changes: [
            { key: 'skill:notes', selected: true },
            { key: 'skill:notes', selected: false },
          ],
        },
        deps
      )
    ).toEqual({ ok: false, reason: 'ambiguous-alias' });
    expect(commits()).toBe(0);
    deps.commit = async (snapshot, patch) => {
      repo.updateSession('fixture', {
        config: { ...repo.getSession('fixture')!.config, autoScroll: false },
      });
      return repo.casSessionRuntimeSettings(snapshot, patch);
    };
    expect(
      await changeSessionToolChoice(
        {
          sessionId: 'fixture',
          changes: [
            { key: 'skill:notes', selected: true },
            { key: 'mcp:browser', selected: true },
          ],
        },
        deps
      )
    ).toEqual({ ok: false, reason: 'superseded' });
    expect(repo.getSession('fixture')!.config.toolSelection).toEqual(selection());
  });
});
