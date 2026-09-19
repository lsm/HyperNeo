import { describe, expect, test } from 'bun:test';
import type { McpServer } from '@hyperneo/shared/sdk';
import { assembleSessionBriefing } from '../../../../src/lib/briefings/assemble-session-briefing.ts';
import type { AttachedMcpServerConfig } from '../../../../src/lib/briefings/contribution.ts';
import {
  isBuiltInMcpServer,
  OPERATIONS_MCP_SERVER_NAME,
} from '../../../../src/lib/mcp/built-in-servers.ts';
import { operationsCapabilityContribution } from '../../../../src/lib/operations/door-briefing.ts';

const ATTACHED: AttachedMcpServerConfig = {
  type: 'sdk',
  name: OPERATIONS_MCP_SERVER_NAME,
  instance: {} as McpServer,
};

describe('operationsCapabilityContribution', () => {
  test('pairs the attached operations server with its authored briefing', () => {
    const contribution = operationsCapabilityContribution(ATTACHED);

    expect(contribution.kind).toBe('authored');
    expect(contribution.server.name).toBe(OPERATIONS_MCP_SERVER_NAME);
    expect(contribution.server.config).toBe(ATTACHED);
    expect(contribution.briefing.trim().length).toBeGreaterThan(0);
  });

  test('carries a config the built-in predicate can recognise as first-party', () => {
    const { server } = operationsCapabilityContribution(ATTACHED);

    expect(isBuiltInMcpServer(server.name, server.config)).toBe(true);
  });

  test('states the shape of the door and points at operations.describe', () => {
    const { briefing } = operationsCapabilityContribution(ATTACHED);

    expect(briefing).toContain('mcp__hyperneo-operations__invoke');
    expect(briefing).toContain('operations.list');
    expect(briefing).toContain('operations.describe');
  });

  test('names no individual operation, leaving the listing to the registry', () => {
    const { briefing } = operationsCapabilityContribution(ATTACHED);

    expect(briefing).not.toContain('task.create');
    expect(briefing).not.toContain('message.send');
  });

  test('describes without granting', () => {
    const { briefing } = operationsCapabilityContribution(ATTACHED);

    expect(briefing.toLowerCase()).not.toContain('you are allowed');
    expect(briefing.toLowerCase()).not.toContain('you may call any');
    expect(briefing.toLowerCase()).not.toContain('permission');
  });

  test('assembles under the server name, after the session scope', () => {
    const { sections } = assembleSessionBriefing({
      scope: [{ facet: 'space', briefing: 'scope text' }],
      capabilities: [operationsCapabilityContribution(ATTACHED)],
    });

    expect(sections.map((section) => [section.kind, section.key])).toEqual([
      ['scope', 'space'],
      ['capability', OPERATIONS_MCP_SERVER_NAME],
    ]);
  });
});
