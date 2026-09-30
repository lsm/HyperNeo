import { describe, expect, test } from 'bun:test';
import {
  CAPABILITY_UNITS,
  checkCapabilityCoverage,
  describeCapabilityCoverageIssue,
  findCapabilityUnit,
} from '../../../../src/lib/briefings/capability-registry';
import type { CapabilityContribution } from '../../../../src/lib/briefings/contribution';
import {
  AGENT_MEMORY_MCP_SERVER_NAME,
  DB_QUERY_MCP_SERVER_NAME,
  OPERATIONS_MCP_SERVER_NAME,
} from '../../../../src/lib/mcp/built-in-servers';

function authored(serverName: string, briefing = 'doctrine'): CapabilityContribution {
  return { kind: 'authored', server: { name: serverName, config: {} }, briefing };
}

function selfDescribing(serverName: string): CapabilityContribution {
  return { kind: 'self-describing', server: { name: serverName, config: {} } };
}

describe('capability registry', () => {
  test('every declared unit names a distinct server', () => {
    const names = CAPABILITY_UNITS.map((unit) => unit.serverName);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain(OPERATIONS_MCP_SERVER_NAME);
    expect(names).toContain(AGENT_MEMORY_MCP_SERVER_NAME);
    expect(names).toContain(DB_QUERY_MCP_SERVER_NAME);
  });

  test('a declared unit resolves by server name', () => {
    expect(findCapabilityUnit(OPERATIONS_MCP_SERVER_NAME)).toMatchObject({
      kind: 'authored',
    });
    expect(findCapabilityUnit('not-a-capability')).toBeUndefined();
  });
});

describe('checkCapabilityCoverage', () => {
  test('accepts every declared capability with its declared briefing kind', () => {
    const contributions = CAPABILITY_UNITS.map((unit) =>
      unit.kind === 'authored' ? authored(unit.serverName) : selfDescribing(unit.serverName)
    );

    expect(checkCapabilityCoverage(contributions)).toEqual([]);
  });

  test('reports an attached server that has no declared unit', () => {
    expect(checkCapabilityCoverage([authored('mystery-server')])).toEqual([
      { kind: 'undeclared', serverName: 'mystery-server' },
    ]);
  });

  test('reports a capability whose briefing kind drifted from its declaration', () => {
    expect(checkCapabilityCoverage([selfDescribing(DB_QUERY_MCP_SERVER_NAME)])).toEqual([
      {
        kind: 'briefing_mismatch',
        serverName: DB_QUERY_MCP_SERVER_NAME,
        declared: 'authored',
        actual: 'self-describing',
      },
    ]);
  });

  test('reports an authored capability that contributed nothing to say', () => {
    expect(checkCapabilityCoverage([authored(DB_QUERY_MCP_SERVER_NAME, '   ')])).toEqual([
      { kind: 'empty_briefing', serverName: DB_QUERY_MCP_SERVER_NAME },
    ]);
  });

  test('reports every issue instead of stopping at the first', () => {
    const issues = checkCapabilityCoverage([
      authored('mystery-server'),
      selfDescribing(DB_QUERY_MCP_SERVER_NAME),
    ]);

    expect(issues).toHaveLength(2);
  });

  test('an empty contribution set is covered', () => {
    expect(checkCapabilityCoverage([])).toEqual([]);
  });
});

describe('describeCapabilityCoverageIssue', () => {
  test('names the server and the remedy for each issue kind', () => {
    expect(describeCapabilityCoverageIssue({ kind: 'undeclared', serverName: 'x' })).toContain(
      'no declared unit'
    );
    expect(
      describeCapabilityCoverageIssue({
        kind: 'briefing_mismatch',
        serverName: 'x',
        declared: 'authored',
        actual: 'self-describing',
      })
    ).toContain('declared authored but contributed self-describing');
    expect(describeCapabilityCoverageIssue({ kind: 'empty_briefing', serverName: 'x' })).toContain(
      'empty briefing'
    );
  });
});
