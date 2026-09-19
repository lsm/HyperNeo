import { describe, expect, test } from 'bun:test';
import type { McpServer } from '@hyperneo/shared/sdk';
import { assembleSessionBriefing } from '../../../../src/lib/briefings/assemble-session-briefing.ts';
import type { AttachedMcpServerConfig } from '../../../../src/lib/briefings/contribution.ts';
import { dbQueryCapabilityContribution } from '../../../../src/lib/db-query/briefing.ts';
import {
  AGENT_MEMORY_MCP_SERVER_NAME,
  DB_QUERY_MCP_SERVER_NAME,
  isBuiltInMcpServer,
} from '../../../../src/lib/mcp/built-in-servers.ts';
import { agentMemoryCapabilityContribution } from '../../../../src/lib/space/tools/agent-memory-briefing.ts';

function attached(name: string): AttachedMcpServerConfig {
  return { type: 'sdk', name, instance: {} as McpServer };
}

const MEMORY_SERVER = attached(AGENT_MEMORY_MCP_SERVER_NAME);
const DB_QUERY_SERVER = attached(DB_QUERY_MCP_SERVER_NAME);

describe('agentMemoryCapabilityContribution', () => {
  test('pairs the attached agent-memory server with an authored briefing', () => {
    const contribution = agentMemoryCapabilityContribution(MEMORY_SERVER);

    expect(contribution.kind).toBe('authored');
    expect(contribution.server.name).toBe(AGENT_MEMORY_MCP_SERVER_NAME);
    expect(contribution.server.config).toBe(MEMORY_SERVER);
    expect(contribution.briefing.trim().length).toBeGreaterThan(0);
    expect(isBuiltInMcpServer(contribution.server.name, contribution.server.config)).toBe(true);
  });

  test('says what the store is for without naming a tool schema', () => {
    const { briefing } = agentMemoryCapabilityContribution(MEMORY_SERVER);

    expect(briefing).toContain('`agent-memory`');
    expect(briefing).not.toContain('memory.write');
    expect(briefing).not.toContain('memory.search');
  });

  test('claims nothing about the servers a session does not hold', () => {
    const { briefing } = agentMemoryCapabilityContribution(MEMORY_SERVER);

    expect(briefing).not.toContain(DB_QUERY_MCP_SERVER_NAME);
    expect(briefing).toContain('it is not attached to every session here');
  });

  test('describes without granting', () => {
    const briefing = agentMemoryCapabilityContribution(MEMORY_SERVER).briefing.toLowerCase();

    expect(briefing).not.toContain('permission');
    expect(briefing).not.toContain('you are allowed');
  });
});

describe('dbQueryCapabilityContribution', () => {
  test('pairs the attached db-query server with an authored briefing', () => {
    const contribution = dbQueryCapabilityContribution(DB_QUERY_SERVER);

    expect(contribution.kind).toBe('authored');
    expect(contribution.server.name).toBe(DB_QUERY_MCP_SERVER_NAME);
    expect(contribution.server.config).toBe(DB_QUERY_SERVER);
    expect(contribution.briefing.trim().length).toBeGreaterThan(0);
    expect(isBuiltInMcpServer(contribution.server.name, contribution.server.config)).toBe(true);
  });

  test('states the read-only scope filter and what an empty result means', () => {
    const { briefing } = dbQueryCapabilityContribution(DB_QUERY_SERVER);

    expect(briefing).toContain('`db-query`');
    expect(briefing).toContain('read-only');
    expect(briefing).toContain('"not here"');
  });

  test('claims nothing about the servers a session does not hold', () => {
    const { briefing } = dbQueryCapabilityContribution(DB_QUERY_SERVER);

    expect(briefing).not.toContain(AGENT_MEMORY_MCP_SERVER_NAME);
    expect(briefing).not.toContain('hyperneo-operations');
  });

  test('describes without granting', () => {
    const briefing = dbQueryCapabilityContribution(DB_QUERY_SERVER).briefing.toLowerCase();

    expect(briefing).not.toContain('permission');
    expect(briefing).not.toContain('you are allowed');
  });
});

describe('assembleSessionBriefing', () => {
  test('orders the two built-in briefings under their server names', () => {
    const { sections } = assembleSessionBriefing({
      scope: [{ facet: 'space', briefing: 'scope text' }],
      capabilities: [
        dbQueryCapabilityContribution(DB_QUERY_SERVER),
        agentMemoryCapabilityContribution(MEMORY_SERVER),
      ],
    });

    expect(sections.map((section) => [section.kind, section.key])).toEqual([
      ['scope', 'space'],
      ['capability', AGENT_MEMORY_MCP_SERVER_NAME],
      ['capability', DB_QUERY_MCP_SERVER_NAME],
    ]);
  });
});
