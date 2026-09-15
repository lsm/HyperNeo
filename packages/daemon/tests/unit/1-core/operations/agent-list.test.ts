import { describe, expect, mock, test } from 'bun:test';
import type { SpaceLongHorizonAgent } from '@hyperneo/shared';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { createAgentListOperation } from '../../../../src/lib/operations/agents/agent-list';

const agents: SpaceLongHorizonAgent[] = [
  {
    id: 'agent-1',
    spaceId: 'space-id',
    handle: 'first',
    displayName: 'First',
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
  },
  {
    id: 'agent-2',
    spaceId: 'space-id',
    handle: 'second',
    displayName: 'Second',
    templateKey: null,
    status: 'paused',
    sessionId: null,
    instructions: '',
    autonomyLevel: null,
    model: null,
    thinkingLevel: null,
    provider: null,
    settingSources: null,
    toolPermissions: {},
    createdAt: 20,
    updatedAt: 20,
  },
];

function fixture(value: SpaceLongHorizonAgent[] = agents) {
  const list = mock((_spaceId: string, _caller) => value);
  return { list, registry: createOperationRegistry([createAgentListOperation(list)]) };
}

describe('agent.list operation', () => {
  test.each(['rpc', 'mcp', 'internal'] as const)('lists agents for %s callers', async (source) => {
    const { list, registry } = fixture();
    expect(
      await invokeOperation(registry, 'agent.list', { spaceId: 'space-id' }, { source })
    ).toEqual({
      kind: 'completed',
      value: { success: true, agents },
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith('space-id', { source });
  });

  test('filters by status', async () => {
    const { list, registry } = fixture();
    expect(
      await invokeOperation(
        registry,
        'agent.list',
        { spaceId: 'space-id', status: 'paused' },
        { source: 'rpc' }
      )
    ).toEqual({
      kind: 'completed',
      value: { success: true, agents: [agents[1]] },
    });
    expect(list).toHaveBeenCalledWith('space-id', { source: 'rpc' });
  });

  test('returns compact summaries when compact is true', async () => {
    const { list, registry } = fixture();
    expect(
      await invokeOperation(
        registry,
        'agent.list',
        { spaceId: 'space-id', compact: true },
        { source: 'rpc' }
      )
    ).toMatchObject({
      kind: 'completed',
      value: {
        success: true,
        agents: [
          {
            id: agents[0].id,
            handle: agents[0].handle,
            displayName: agents[0].displayName,
            status: agents[0].status,
            model: agents[0].model,
            provider: agents[0].provider,
            thinkingLevel: agents[0].thinkingLevel,
            templateKey: agents[0].templateKey,
            updatedAt: agents[0].updatedAt,
          },
          {
            id: agents[1].id,
            handle: agents[1].handle,
            displayName: agents[1].displayName,
            status: agents[1].status,
            model: agents[1].model,
            provider: agents[1].provider,
            thinkingLevel: agents[1].thinkingLevel,
            templateKey: agents[1].templateKey,
            updatedAt: agents[1].updatedAt,
          },
        ],
      },
    });
  });

  test.each([{}, { spaceId: '' }, { spaceId: 1 }] as const)(
    'rejects invalid space IDs before listing: %j',
    async (input) => {
      const { list, registry } = fixture();
      expect(await invokeOperation(registry, 'agent.list', input, { source: 'mcp' })).toMatchObject(
        {
          kind: 'failed',
          code: 'invalid_input',
        }
      );
      expect(list).not.toHaveBeenCalled();
    }
  );
});
