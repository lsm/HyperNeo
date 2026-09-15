import { describe, expect, mock, test } from 'bun:test';
import type { SpaceLongHorizonAgent } from '@hyperneo/shared';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { createAgentGetOperation } from '../../../../src/lib/operations/agents/agent-get';

const agent: SpaceLongHorizonAgent = {
  id: 'agent-id',
  spaceId: 'space-id',
  handle: 'agent-handle',
  displayName: 'Agent',
  templateKey: null,
  status: 'active',
  sessionId: null,
  instructions: '',
  autonomyLevel: null,
  model: null,
  thinkingLevel: null,
  provider: null,
  settingSources: null,
  toolPermissions: {},
  createdAt: 10,
  updatedAt: 10,
};

function fixture(value: SpaceLongHorizonAgent | null = agent) {
  const get = mock((_agentId: string, _caller) => value);
  return { get, registry: createOperationRegistry([createAgentGetOperation(get)]) };
}

describe('agent.get operation', () => {
  test.each(['rpc', 'mcp', 'internal'] as const)(
    'reads an agent for %s callers',
    async (source) => {
      const { get, registry } = fixture();
      expect(
        await invokeOperation(registry, 'agent.get', { agentId: agent.id }, { source })
      ).toEqual({
        kind: 'completed',
        value: { success: true, agent },
      });
      expect(get).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenCalledWith(agent.id, { source });
    }
  );

  test('returns an execution failure for an absent agent', async () => {
    const { registry } = fixture(null);
    const result = await invokeOperation(
      registry,
      'agent.get',
      { agentId: 'absent' },
      { source: 'rpc' }
    );
    expect(result).toMatchObject({
      kind: 'failed',
      code: 'execution_failed',
      message: 'Long-horizon agent not found: absent',
    });
  });

  test.each([{}, { agentId: '' }, { agentId: 1 }] as const)(
    'rejects invalid agent IDs before reading: %j',
    async (input) => {
      const { get, registry } = fixture();
      expect(await invokeOperation(registry, 'agent.get', input, { source: 'mcp' })).toMatchObject({
        kind: 'failed',
        code: 'invalid_input',
      });
      expect(get).not.toHaveBeenCalled();
    }
  );

  test('rejects extra input keys', async () => {
    const { get, registry } = fixture();
    expect(
      await invokeOperation(
        registry,
        'agent.get',
        { agentId: agent.id, extra: 'key' },
        { source: 'rpc' }
      )
    ).toMatchObject({
      kind: 'failed',
      code: 'invalid_input',
    });
    expect(get).not.toHaveBeenCalled();
  });
});
