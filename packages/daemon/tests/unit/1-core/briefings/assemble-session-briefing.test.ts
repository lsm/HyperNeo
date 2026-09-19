import { describe, expect, test } from 'bun:test';
import {
  assembleSessionBriefing,
  type SessionBriefingContributions,
} from '../../../../src/lib/briefings/assemble-session-briefing';
import type {
  CapabilityContribution,
  ScopeContribution,
  ScopeFacet,
} from '../../../../src/lib/briefings/contribution';

function capability(name: string, briefing: string): CapabilityContribution {
  return {
    kind: 'authored',
    server: { name, config: { command: 'bun', args: [name] } },
    briefing,
  };
}

function selfDescribing(name: string): CapabilityContribution {
  return { kind: 'self-describing', server: { name, config: { command: 'bun', args: [name] } } };
}

function scope(facet: ScopeFacet, briefing: string): ScopeContribution {
  return { facet, briefing };
}

const allScope: readonly ScopeContribution[] = [
  scope('space', 'space text'),
  scope('role', 'role text'),
  scope('workspace', 'workspace text'),
  scope('standing_instructions', 'standing text'),
];

const allCapabilities: readonly CapabilityContribution[] = [
  capability('hyperneo-operations', 'operations text'),
  capability('agent-memory', 'memory text'),
  capability('db-query', 'query text'),
];

function keysOf(contributions: SessionBriefingContributions): string[] {
  return assembleSessionBriefing(contributions).sections.map((section) => section.key);
}

describe('assembleSessionBriefing', () => {
  test('scope sections precede capability sections', () => {
    const { sections } = assembleSessionBriefing({
      scope: [scope('role', 'role text')],
      capabilities: [capability('agent-memory', 'memory text')],
    });

    expect(sections).toEqual([
      { kind: 'scope', key: 'role', briefing: 'role text' },
      { kind: 'capability', key: 'agent-memory', briefing: 'memory text' },
    ]);
  });

  test('scope sections follow the declared facet order, not the input order', () => {
    expect(keysOf({ scope: allScope, capabilities: [] })).toEqual([
      'space',
      'role',
      'workspace',
      'standing_instructions',
    ]);
    expect(keysOf({ scope: [...allScope].reverse(), capabilities: [] })).toEqual([
      'space',
      'role',
      'workspace',
      'standing_instructions',
    ]);
  });

  test('capability sections are ordered by server name, not by attachment order', () => {
    expect(keysOf({ scope: [], capabilities: allCapabilities })).toEqual([
      'agent-memory',
      'db-query',
      'hyperneo-operations',
    ]);
    expect(keysOf({ scope: [], capabilities: [...allCapabilities].reverse() })).toEqual([
      'agent-memory',
      'db-query',
      'hyperneo-operations',
    ]);
  });

  test('assembly is a pure function of its inputs', () => {
    const scopeInput = [...allScope].reverse();
    const capabilityInput = [...allCapabilities].reverse();
    const contributions = { scope: scopeInput, capabilities: capabilityInput };

    const first = assembleSessionBriefing(contributions);
    const second = assembleSessionBriefing({
      scope: [...allScope],
      capabilities: [...allCapabilities],
    });

    expect(first).toEqual(second);
    expect(scopeInput).toEqual([...allScope].reverse());
    expect(capabilityInput).toEqual([...allCapabilities].reverse());
  });

  test('text joins the sections in order, separated by a blank line', () => {
    const { text } = assembleSessionBriefing({
      scope: [scope('space', '  space text  ')],
      capabilities: [capability('db-query', 'query text'), capability('agent-memory', 'memory\n')],
    });

    expect(text).toBe('space text\n\nmemory\n\nquery text');
  });

  test('a contribution with a blank briefing is rejected', () => {
    expect(() =>
      assembleSessionBriefing({ scope: [], capabilities: [capability('db-query', '   \n')] })
    ).toThrow('capability "db-query" contributed no briefing');
    expect(() =>
      assembleSessionBriefing({ scope: [scope('space', '')], capabilities: [] })
    ).toThrow('scope "space" contributed no briefing');
  });

  test('a self-describing contribution carries the server without adding a section', () => {
    const { sections, text } = assembleSessionBriefing({
      scope: [],
      capabilities: [capability('agent-memory', 'memory text'), selfDescribing('search')],
    });

    expect(sections.map((section) => section.key)).toEqual(['agent-memory']);
    expect(text).toBe('memory text');
  });

  test('a self-describing contribution still claims its server name', () => {
    expect(() =>
      assembleSessionBriefing({
        scope: [],
        capabilities: [selfDescribing('search'), capability('search', 'authored text')],
      })
    ).toThrow('duplicate capability server "search"');
  });

  test('a repeated server or facet is rejected instead of silently collapsing', () => {
    expect(() =>
      assembleSessionBriefing({
        scope: [],
        capabilities: [capability('db-query', 'first'), capability('db-query', 'second')],
      })
    ).toThrow('duplicate capability server "db-query"');
    expect(() =>
      assembleSessionBriefing({
        scope: [scope('role', 'first'), scope('role', 'second')],
        capabilities: [],
      })
    ).toThrow('duplicate scope facet "role"');
  });
});
