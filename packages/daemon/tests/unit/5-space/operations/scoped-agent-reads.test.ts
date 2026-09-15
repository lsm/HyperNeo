import { describe, expect, mock, test } from 'bun:test';
import type { Session, SpaceLongHorizonAgent } from '@hyperneo/shared';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { createAgentGetOperation } from '../../../../src/lib/operations/agents/agent-get';
import {
  readScopedAgent,
  listScopedAgents,
} from '../../../../src/lib/space/operations/scoped-agent-reads';

const agent: SpaceLongHorizonAgent = {
  id: 'agent-id',
  spaceId: 'space-a',
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

function sessionForSpace(spaceId: string): Session {
  return {
    id: `session:${spaceId}`,
    type: 'space_chat',
    status: 'active',
    metadata: {},
    createdAt: 0,
    title: '',
    context: { spaceId },
    messages: [],
    tools: [],
    provider: null,
    model: null,
  };
}

const admission = {
  getSession: (sessionId: string) =>
    sessionId === 'session:space-a'
      ? sessionForSpace('space-a')
      : sessionId === 'session:space-b'
        ? sessionForSpace('space-b')
        : null,
  longHorizonAgentRepo: { getById: () => agent },
};

describe('scoped agent reads', () => {
  test('allow MCP caller in the owning space', () => {
    expect(
      listScopedAgents(
        { source: 'mcp', sessionId: 'session:space-a' },
        admission,
        () => [agent],
        'space-a'
      )
    ).toEqual([agent]);
    expect(
      readScopedAgent(
        { source: 'mcp', sessionId: 'session:space-a' },
        admission,
        () => agent,
        'agent-id'
      )
    ).toEqual(agent);
  });

  test('deny MCP caller outside the owning space', () => {
    expect(
      listScopedAgents(
        { source: 'mcp', sessionId: 'session:space-b' },
        admission,
        () => [agent],
        'space-a'
      )
    ).toEqual([]);
    expect(() =>
      readScopedAgent(
        { source: 'mcp', sessionId: 'session:space-b' },
        admission,
        () => agent,
        'agent-id'
      )
    ).toThrow('Long-horizon agent not found');
  });

  test('allow RPC and internal callers without a session', () => {
    expect(listScopedAgents({ source: 'rpc' }, admission, () => [agent], 'space-a')).toEqual([
      agent,
    ]);
    expect(readScopedAgent({ source: 'rpc' }, admission, () => agent, 'agent-id')).toEqual(agent);
    expect(listScopedAgents({ source: 'internal' }, admission, () => [agent], 'space-a')).toEqual([
      agent,
    ]);
    expect(readScopedAgent({ source: 'internal' }, admission, () => agent, 'agent-id')).toEqual(
      agent
    );
  });

  test('readScopedAgent reports missing agent as not found', () => {
    expect(() =>
      readScopedAgent({ source: 'mcp', sessionId: 'session:space-a' }, admission, () => null, 'x')
    ).toThrow('Long-horizon agent not found');
  });

  test('readScopedAgent reports denied foreign agent as not found', () => {
    expect(() =>
      readScopedAgent(
        { source: 'mcp', sessionId: 'session:space-b' },
        admission,
        () => agent,
        'agent-id'
      )
    ).toThrow('Long-horizon agent not found');
  });

  test('operation registry uses scoped reads when supplied', async () => {
    const get = mock((id: string) => (id === 'agent-id' ? agent : null));
    const scopedGet = (agentId: string, caller) => readScopedAgent(caller, admission, get, agentId);
    const registry = createOperationRegistry([createAgentGetOperation(scopedGet)]);
    expect(
      await registry
        .get('agent.get')!
        .execute({ agentId: 'agent-id' }, { source: 'mcp', sessionId: 'session:space-a' })
    ).toEqual({ success: true, agent });
    expect(get).toHaveBeenCalledWith('agent-id');
  });
});
