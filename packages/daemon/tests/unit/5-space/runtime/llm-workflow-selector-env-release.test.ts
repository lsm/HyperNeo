import { describe, expect, it, mock } from 'bun:test';
import type { SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import * as realProviderService from '../../../../src/lib/provider-service';

const events: string[] = [];
let lastQueryEnv: Record<string, string | undefined> | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { options?: { env?: Record<string, string | undefined> } }) => {
    events.push(
      `query:${process.env.ANTHROPIC_BASE_URL === 'https://relay.example' ? 'leaked' : 'clean'}`
    );
    lastQueryEnv = params.options?.env;
    return (async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'wf-two' }] },
      };
    })();
  },
}));

const stubProviderService = {
  getDefaultProvider: async () => 'glm',
  getTitleGenerationConfig: async () => ({
    modelId: 'glm-4.6',
    baseUrl: 'https://relay.example',
    apiVersion: 'v1',
  }),
  getEnvVarsForModel: async () => ({ ANTHROPIC_MODEL: 'glm-4.6' }),
  getIsolatedEnvForModel: async () => {
    events.push('env');
    return { ...process.env, ANTHROPIC_BASE_URL: 'https://relay.example' };
  },
};

mock.module('../../../../src/lib/provider-service.ts', () => ({
  ...realProviderService,
  getProviderService: () => stubProviderService,
}));

describe('selectWorkflowWithLlmDefault provider env release', () => {
  it('passes the provider env to the SDK query without touching process.env', async () => {
    const { selectWorkflowWithLlmDefault } = await import(
      '../../../../src/lib/workflows/llm-workflow-selector'
    );
    const task = {
      title: 'Ship the release',
      description: 'Cut and publish',
    } as unknown as SpaceTask;
    const workflows = [
      { id: 'wf-one', name: 'One', description: '', tags: [] },
      { id: 'wf-two', name: 'Two', description: '', tags: [] },
    ] as unknown as SpaceWorkflow[];

    const selected = await selectWorkflowWithLlmDefault(task, workflows);

    expect(selected).toBe('wf-two');
    expect(events).toEqual(['env', 'query:clean']);
    expect(lastQueryEnv?.ANTHROPIC_BASE_URL).toBe('https://relay.example');
  });
});
