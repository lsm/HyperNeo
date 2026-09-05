import { describe, expect, test } from 'bun:test';
import type { Space, SpaceLongHorizonAgent } from '@hyperneo/shared';
import { buildAgentSessionConfig } from '../../../../src/lib/session-resolution/agent-session-config';

const NOW = Date.now();

const mockSpace: Space = {
  id: 'space-1',
  slug: 'test-space',
  workspacePath: '/tmp/test-workspace',
  name: 'Test Space',
  description: '',
  backgroundContext: '',
  instructions: '',
  sessionIds: [],
  status: 'active',
  paused: false,
  stopped: false,
  maxConcurrentTasks: 3,
  createdAt: NOW,
  updatedAt: NOW,
};

function makeAgent(
  id: string,
  overrides: Partial<SpaceLongHorizonAgent> = {}
): SpaceLongHorizonAgent {
  return {
    id,
    spaceId: 'space-1',
    handle: id,
    displayName: `Agent ${id}`,
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
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('buildAgentSessionConfig — long-horizon arm', () => {
  test('deterministic fixture produces the expected literal config', async () => {
    const agent = makeAgent('lh-set', {
      model: 'model-x',
      provider: 'provider-x',
      thinkingLevel: 'think8k',
      instructions: '  Own the goal.  ',
      toolPermissions: { tools: ['Read'] },
    });

    const config = await buildAgentSessionConfig({ agent }, mockSpace);

    expect(config.model).toBe('model-x');
    expect(config.provider).toBe('provider-x');
    expect(config.thinkingLevel).toBe('think8k');
    expect(config.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });
  });
});
