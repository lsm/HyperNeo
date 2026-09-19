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
  test('uses the first pool entry for the persistent session regardless of workflow weights', async () => {
    const agent = makeAgent('pooled', {
      modelPool: [
        {
          model: 'pool-first',
          provider: 'openrouter',
          thinkingLevel: 'think8k',
          weight: 1,
          maxConcurrent: 1,
        },
        { model: 'pool-second', provider: 'glm', weight: 10, maxConcurrent: 10 },
      ],
    });
    const config = await buildAgentSessionConfig(
      { agent },
      { ...mockSpace, defaultModel: 'space-default' }
    );
    expect(config.model).toBe('pool-first');
    expect(config.provider).toBe('openrouter');
    expect(config.thinkingLevel).toBe('think8k');
  });

  test('keeps scalar configuration precedence over a legacy pool', async () => {
    const agent = makeAgent('scalar', {
      model: 'scalar-model',
      provider: 'glm',
      thinkingLevel: 'think16k',
      modelPool: [{ model: 'pool-model', provider: 'openrouter', weight: 1, maxConcurrent: 1 }],
    });
    const config = await buildAgentSessionConfig({ agent }, mockSpace);
    expect(config).toMatchObject({
      model: 'scalar-model',
      provider: 'glm',
      thinkingLevel: 'think16k',
    });
  });

  test('keeps the space default for an empty pool', async () => {
    const config = await buildAgentSessionConfig(
      { agent: makeAgent('empty', { modelPool: [] }) },
      { ...mockSpace, defaultModel: 'space-model' },
      { model: 'space-model', provider: 'openrouter' }
    );
    expect(config).toMatchObject({ model: 'space-model', provider: 'openrouter' });
  });

  test('keeps the current provider for an unqualified pool entry with the same model', async () => {
    const config = await buildAgentSessionConfig(
      {
        agent: makeAgent('unqualified', {
          modelPool: [{ model: 'shared-model', weight: 1, maxConcurrent: 1 }],
        }),
      },
      mockSpace,
      { model: 'shared-model', provider: 'openrouter' }
    );
    expect(config).toMatchObject({ model: 'shared-model', provider: 'openrouter' });
  });

  test('deterministic fixture produces the expected literal config', async () => {
    const agent = makeAgent('lh-set', {
      model: 'model-x',
      provider: 'openrouter',
      thinkingLevel: 'think8k',
      instructions: '  Own the goal.  ',
      toolPermissions: { tools: ['Read'] },
    });

    const config = await buildAgentSessionConfig({ agent }, mockSpace);

    expect(config.model).toBe('model-x');
    expect(config.provider).toBe('openrouter');
    expect(config.thinkingLevel).toBe('think8k');
    expect(config.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });
  });
});
