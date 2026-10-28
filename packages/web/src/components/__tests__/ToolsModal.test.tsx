import { describe, it, expect } from 'vitest';
import type { AppMcpServer, AppSkill, SessionMcpServerEntry } from '@hyperneo/shared';
import {
  buildDisabledSkillsList,
  computeSkillGroupState,
  getMcpServerEffectiveEnabled,
  getMcpServerProvenanceBadge,
} from '../ToolsModal.utils.ts';

describe('computeSkillGroupState', () => {
  it('returns all-false for empty skills list (no vacuous truth)', () => {
    const state = computeSkillGroupState([]);
    expect(state.allEnabled).toBe(false);
    expect(state.someEnabled).toBe(false);
    expect(state.isIndeterminate).toBe(false);
  });

  it('returns allEnabled=true when all skills are enabled', () => {
    const state = computeSkillGroupState([{ enabled: true }, { enabled: true }]);
    expect(state.allEnabled).toBe(true);
    expect(state.someEnabled).toBe(true);
    expect(state.isIndeterminate).toBe(false);
  });

  it('returns allEnabled=false, someEnabled=false when all skills are disabled', () => {
    const state = computeSkillGroupState([{ enabled: false }, { enabled: false }]);
    expect(state.allEnabled).toBe(false);
    expect(state.someEnabled).toBe(false);
    expect(state.isIndeterminate).toBe(false);
  });

  it('returns isIndeterminate=true when some skills are enabled', () => {
    const state = computeSkillGroupState([{ enabled: true }, { enabled: false }]);
    expect(state.allEnabled).toBe(false);
    expect(state.someEnabled).toBe(true);
    expect(state.isIndeterminate).toBe(true);
  });
});

function makeMcpSkill(overrides: Partial<AppSkill> = {}): AppSkill {
  return {
    id: 'skill-1',
    name: 'chrome-devtools-mcp',
    displayName: 'Chrome DevTools (MCP)',
    description: '',
    sourceType: 'mcp_server',
    config: { type: 'mcp_server', appMcpServerId: 'server-1' },
    enabled: true,
    builtIn: false,
    validationStatus: 'valid',
    createdAt: 0,
    ...overrides,
  };
}

function makeBuiltinSkill(overrides: Partial<AppSkill> = {}): AppSkill {
  return {
    id: 'skill-builtin',
    name: 'playwright',
    displayName: 'Playwright',
    description: '',
    sourceType: 'builtin',
    config: { type: 'builtin', commandName: 'playwright' },
    enabled: true,
    builtIn: true,
    validationStatus: 'valid',
    createdAt: 0,
    ...overrides,
  };
}

function makePluginSkill(overrides: Partial<AppSkill> = {}): AppSkill {
  return {
    id: 'skill-plugin',
    name: 'my-plugin',
    displayName: 'My Plugin',
    description: '',
    sourceType: 'plugin',
    config: { type: 'plugin', pluginPath: '/tmp/my-plugin' },
    enabled: true,
    builtIn: false,
    validationStatus: 'valid',
    createdAt: 0,
    ...overrides,
  };
}

function makeAppMcpServer(overrides: Partial<AppMcpServer> = {}): AppMcpServer {
  return {
    id: 'server-1',
    name: 'chrome-devtools',
    sourceType: 'stdio',
    command: 'bunx',
    args: ['chrome-devtools-mcp@latest'],
    env: {},
    enabled: true,
    source: 'builtin',
    ...overrides,
  };
}

function makeEntry(overrides: Partial<SessionMcpServerEntry> = {}): SessionMcpServerEntry {
  return {
    server: makeAppMcpServer(),
    enabled: true,
    source: 'registry',
    ...overrides,
  };
}

describe('buildDisabledSkillsList', () => {
  it('returns the IDs of skills currently in the pending set', () => {
    const skills = [
      makeBuiltinSkill({ id: 'a' }),
      makeMcpSkill({ id: 'b' }),
      makePluginSkill({ id: 'c' }),
    ];
    expect(buildDisabledSkillsList(skills, new Set(['a', 'c']))).toEqual(['a', 'c']);
  });

  it('drops pending IDs that no longer correspond to a registry entry', () => {
    const skills = [makeBuiltinSkill({ id: 'still-here' })];
    expect(buildDisabledSkillsList(skills, new Set(['still-here', 'ghost-id']))).toEqual([
      'still-here',
    ]);
  });

  it('returns an empty array when nothing is pending', () => {
    const skills = [makeBuiltinSkill({ id: 'a' })];
    expect(buildDisabledSkillsList(skills, new Set())).toEqual([]);
  });
});

describe('getMcpServerProvenanceBadge', () => {
  it('labels builtin servers as "Built-in"', () => {
    const badge = getMcpServerProvenanceBadge(makeAppMcpServer({ source: 'builtin' }));
    expect(badge.label).toBe('Built-in');
  });

  it('labels imported servers as "Imported"', () => {
    const badge = getMcpServerProvenanceBadge(
      makeAppMcpServer({ source: 'imported', sourcePath: '/tmp/.mcp.json' })
    );
    expect(badge.label).toBe('Imported');
  });

  it('labels user-created servers as "User"', () => {
    const badge = getMcpServerProvenanceBadge(makeAppMcpServer({ source: 'user' }));
    expect(badge.label).toBe('User');
  });
});

describe('getMcpServerEffectiveEnabled', () => {
  it('uses the daemon-resolved value when there is no pending change', () => {
    const entry = makeEntry({ enabled: true });
    expect(getMcpServerEffectiveEnabled(entry, undefined)).toBe(true);

    const entry2 = makeEntry({ enabled: false });
    expect(getMcpServerEffectiveEnabled(entry2, undefined)).toBe(false);
  });

  it('uses the pending boolean when set', () => {
    const entry = makeEntry({ enabled: true });
    expect(getMcpServerEffectiveEnabled(entry, { enabled: false })).toBe(false);
  });

  it('falls back to the daemon-resolved value when pending is a clear (null)', () => {
    const entry = makeEntry({ enabled: false, source: 'session' });
    expect(getMcpServerEffectiveEnabled(entry, { enabled: null })).toBe(false);
  });
});
