import { describe, expect, test } from 'bun:test';
import type { McpServer } from '@hyperneo/shared/sdk';
import { z } from 'zod';
import { assembleSessionBriefing } from '../../../../src/lib/briefings/assemble-session-briefing.ts';
import type { AttachedMcpServerConfig } from '../../../../src/lib/briefings/contribution.ts';
import {
  isBuiltInMcpServer,
  OPERATIONS_MCP_SERVER_NAME,
} from '../../../../src/lib/mcp/built-in-servers.ts';
import {
  describeResolvedOperations,
  operationsCapabilityContribution,
} from '../../../../src/lib/operations/door-briefing.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';

const ATTACHED: AttachedMcpServerConfig = {
  type: 'sdk',
  name: OPERATIONS_MCP_SERVER_NAME,
  instance: {} as McpServer,
};

function stubOperation(name: string) {
  return defineOperation({
    name,
    description: `stub for ${name}`,
    inputSchema: z.object({}),
    resultSchema: z.unknown(),
    execute: async () => undefined,
  });
}

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

describe('describeResolvedOperations', () => {
  test('derives the count and areas from the registry, never a written list', () => {
    const registry = createOperationRegistry([
      stubOperation('task.create'),
      stubOperation('task.cancel'),
      stubOperation('goal.list'),
      stubOperation('operations.list'),
      stubOperation('operations.describe'),
    ]);

    expect(describeResolvedOperations(registry)).toBe(
      "This session's registry currently resolves 3 operations across 2 areas: goal, task."
    );
  });

  test('excludes the discovery operations from the count and leaves no individual name behind', () => {
    const registry = createOperationRegistry([
      stubOperation('task.create'),
      stubOperation('operations.list'),
      stubOperation('operations.describe'),
    ]);

    const listing = describeResolvedOperations(registry);

    expect(listing).toContain('1 operations across 1 areas');
    expect(listing).not.toContain('task.create');
  });

  test('returns an empty string for a registry with nothing to list', () => {
    const registry = createOperationRegistry([
      stubOperation('operations.list'),
      stubOperation('operations.describe'),
    ]);

    expect(describeResolvedOperations(registry)).toBe('');
  });

  test('sorts areas and de-duplicates repeated families', () => {
    const registry = createOperationRegistry([
      stubOperation('workflow.get'),
      stubOperation('agent.get'),
      stubOperation('agent.list'),
    ]);

    expect(describeResolvedOperations(registry)).toBe(
      "This session's registry currently resolves 3 operations across 2 areas: agent, workflow."
    );
  });
});

describe('operationsCapabilityContribution with a resolved registry', () => {
  test('appends the derived listing after the authored prose', () => {
    const registry = createOperationRegistry([stubOperation('task.create')]);

    const { briefing } = operationsCapabilityContribution(ATTACHED, registry);

    expect(briefing.startsWith(operationsCapabilityContribution(ATTACHED).briefing)).toBe(true);
    expect(briefing).toContain('1 operations across 1 areas: task');
  });

  test('never names an individual operation in the derived section either', () => {
    const registry = createOperationRegistry([
      stubOperation('task.create'),
      stubOperation('message.send'),
    ]);

    const { briefing } = operationsCapabilityContribution(ATTACHED, registry);

    expect(briefing).not.toContain('task.create');
    expect(briefing).not.toContain('message.send');
  });

  test('omits the derived section when no registry is supplied, unchanged from before', () => {
    const withoutRegistry = operationsCapabilityContribution(ATTACHED);

    expect(withoutRegistry.briefing).not.toContain('this session');
    expect(withoutRegistry.briefing.toLowerCase()).not.toContain('resolves');
  });
});
