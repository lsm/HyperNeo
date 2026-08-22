import { describe, expect, it } from 'bun:test';
import {
  LimitErrorLlmClassifier,
  type LimitErrorLlmClassifierDeps,
} from '../../../../src/lib/agent/limit-error-llm-classifier';

type QueryOptions = {
  prompt: string;
  options: { model?: string };
};

function createDeps(replyText: string | Error): {
  deps: LimitErrorLlmClassifierDeps;
  prompts: string[];
} {
  const prompts: string[] = [];
  const queryForTesting = ((params: QueryOptions) => {
    prompts.push(params.prompt);
    if (replyText instanceof Error) throw replyText;
    return (async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: replyText }] },
      };
    })();
  }) as LimitErrorLlmClassifierDeps['queryForTesting'];
  const deps: LimitErrorLlmClassifierDeps = {
    providerService: {
      getAvailableProviders: async () => [
        { id: 'glm', name: 'GLM', models: [], available: true },
        { id: 'deepseek', name: 'DeepSeek', models: [], available: true },
      ],
      isProviderAvailable: async () => true,
      getTitleGenerationModels: async () => ({
        providerModelId: 'cheap-model',
        sdkModelId: 'sdk-cheap-model',
      }),
      applyEnvVarsToProcessForProvider: async () => ({}),
      getEnvVarsForModel: async () => ({}),
      restoreEnvVars: () => {},
    },
    queryForTesting,
  };
  return { deps, prompts };
}

describe('LimitErrorLlmClassifier', () => {
  it('parses a JSON reply with an absolute reset instant', async () => {
    const resetAt = Date.now() + 3 * 60 * 60 * 1000;
    const { deps } = createDeps(
      `{"is_limit":true,"kind":"usage_limit","reset_at":${Math.floor(resetAt / 1000)}}`
    );
    const classifier = new LimitErrorLlmClassifier('s1', deps);
    const assessment = await classifier.classify('firewall blocked the request');
    expect(assessment).not.toBeNull();
    expect(assessment?.notALimit).toBe(false);
    expect(assessment?.kind).toBe('usage_limit');
    expect(assessment?.resetAtMs).toBe(Math.floor(resetAt / 1000) * 1000);
  });

  it('strips markdown fences around the JSON reply', async () => {
    const { deps } = createDeps(
      '```json\n{"is_limit":true,"kind":"rate_limit","reset_at":null}\n```'
    );
    const classifier = new LimitErrorLlmClassifier('s1', deps);
    const assessment = await classifier.classify('throttled, try again later');
    expect(assessment?.kind).toBe('rate_limit');
    expect(assessment?.resetAtMs).toBeNull();
  });

  it('treats is_limit=false as notALimit with no reset', async () => {
    const { deps } = createDeps('{"is_limit":false,"kind":null,"reset_at":123}');
    const classifier = new LimitErrorLlmClassifier('s1', deps);
    const assessment = await classifier.classify('Error: 401 unauthorized');
    expect(assessment?.notALimit).toBe(true);
    expect(assessment?.resetAtMs).toBeNull();
  });

  it('returns null when the reply has no JSON object', async () => {
    const { deps } = createDeps('I cannot classify this.');
    const classifier = new LimitErrorLlmClassifier('s1', deps);
    expect(await classifier.classify('weird error')).toBeNull();
  });

  it('returns null when the query throws', async () => {
    const { deps } = createDeps(new Error('sdk spawn failed'));
    const classifier = new LimitErrorLlmClassifier('s1', deps);
    expect(await classifier.classify('weird error')).toBeNull();
  });

  it('prefers a provider that is not the excluded (errored) provider', async () => {
    const seenModels: string[] = [];
    const deps = createDeps('{"is_limit":true,"kind":"rate_limit","reset_at":null}').deps;
    const originalApply = deps.providerService.applyEnvVarsToProcessForProvider;
    deps.providerService = {
      ...deps.providerService,
      applyEnvVarsToProcessForProvider: async (providerId: string, modelId: string) => {
        seenModels.push(`${providerId}/${modelId}`);
        return originalApply(providerId, modelId);
      },
    };
    const classifier = new LimitErrorLlmClassifier('s1', { ...deps, excludeProvider: 'glm' });
    await classifier.classify('429 from glm');
    expect(seenModels).toEqual(['deepseek/cheap-model']);
  });

  it('caches by normalized text so repeated fleet errors hit the cache', async () => {
    const resetAt = Date.now() + 60 * 60 * 1000;
    const { deps, prompts } = createDeps(
      `{"is_limit":true,"kind":"usage_limit","reset_at":${resetAt}}`
    );
    const classifier = new LimitErrorLlmClassifier('s1', deps);
    await classifier.classify('request [2026082114402920abcdef0123] rejected');
    await classifier.classify('request [2026082114403188abcdef9876] rejected');
    expect(prompts).toHaveLength(1);
  });

  it('re-classifies relative-delay errors instead of reusing a cached reset', async () => {
    const { deps, prompts } = createDeps(
      '{"is_limit":true,"kind":"rate_limit","reset_at":1755800000000,"relative":true}'
    );
    const classifier = new LimitErrorLlmClassifier('s1', deps);
    await classifier.classify('quota wall, retry soon');
    await classifier.classify('quota wall, retry soon');
    expect(prompts).toHaveLength(2);
  });

  it('does not cache failed classifications', async () => {
    const { deps, prompts } = createDeps('no json here');
    const classifier = new LimitErrorLlmClassifier('s1', deps);
    await classifier.classify('waf block page');
    await classifier.classify('waf block page');
    expect(prompts).toHaveLength(2);
  });

  it('deduplicates concurrent classifications of the same error text', async () => {
    const { deps, prompts } = createDeps('{"is_limit":true,"kind":"rate_limit","reset_at":null}');
    const classifier = new LimitErrorLlmClassifier('s1', deps);
    await Promise.all([
      classifier.classify('concurrent waf block'),
      classifier.classify('concurrent waf block'),
    ]);
    expect(prompts).toHaveLength(1);
  });

  it('skips the query when the caller aborts during provider setup', async () => {
    let releaseSetup: () => void = () => {};
    const setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    const prompts: string[] = [];
    const { deps } = createDeps('{"is_limit":true,"kind":"rate_limit","reset_at":null}');
    deps.providerService = {
      ...deps.providerService,
      applyEnvVarsToProcessForProvider: async () => {
        await setupGate;
        return {};
      },
    };
    deps.queryForTesting = ((params: { prompt: string }) => {
      prompts.push(params.prompt);
      return (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: '{"is_limit":true,"kind":"rate_limit","reset_at":null}' },
            ],
          },
        };
      })();
    }) as LimitErrorLlmClassifierDeps['queryForTesting'];
    const classifier = new LimitErrorLlmClassifier('s1', deps);

    const controller = new AbortController();
    const pending = classifier.classify('setup abort wall', controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    releaseSetup();

    expect(await pending).toBeNull();
    expect(prompts).toHaveLength(0);
  });

  it('unblocks the caller and skips the query when a queued lookup is aborted mid-queue', async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const prompts: string[] = [];
    const queryForTesting = ((params: { prompt: string }) => {
      prompts.push(params.prompt);
      return (async function* () {
        await firstGate;
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '{"is_limit":false,"kind":null,"reset_at":null}' }],
          },
        };
      })();
    }) as LimitErrorLlmClassifierDeps['queryForTesting'];
    const { deps } = createDeps('{"is_limit":false,"kind":null,"reset_at":null}');
    deps.queryForTesting = queryForTesting;
    const classifier = new LimitErrorLlmClassifier('s1', deps);

    const first = classifier.classify('first distinct queued waf block');
    const controller = new AbortController();
    const second = classifier.classify('second distinct queued waf block', controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    expect(await second).toBeNull();
    releaseFirst();
    expect(await first).not.toBeNull();
    expect(prompts).toHaveLength(1);
  });

  it('preserves the Kimi title thinking config when Kimi classifies', async () => {
    const seenThinking: unknown[] = [];
    const { deps } = createDeps('{"is_limit":true,"kind":"rate_limit","reset_at":null}');
    deps.providerService = {
      ...deps.providerService,
      getAvailableProviders: async () => [
        { id: 'kimi', name: 'Kimi', models: [], available: true },
      ],
      getTitleGenerationModels: async () => ({
        providerModelId: 'kimi-for-coding',
        sdkModelId: 'kimi-for-coding',
      }),
    };
    deps.queryForTesting = ((params: { prompt: string; options: { thinking?: unknown } }) => {
      seenThinking.push(params.options.thinking);
      return (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: '{"is_limit":true,"kind":"rate_limit","reset_at":null}' },
            ],
          },
        };
      })();
    }) as LimitErrorLlmClassifierDeps['queryForTesting'];
    const classifier = new LimitErrorLlmClassifier('s1', { ...deps, excludeProvider: 'glm' });
    await classifier.classify('kimi thinking wall');
    expect(seenThinking).toEqual([{ type: 'enabled', budgetTokens: 16000 }]);
  });

  it('skips registry-unavailable providers and classifies via the next available one', async () => {
    const seenProviders: string[] = [];
    const { deps } = createDeps('{"is_limit":true,"kind":"rate_limit","reset_at":null}');
    const originalApply = deps.providerService.applyEnvVarsToProcessForProvider;
    deps.providerService = {
      ...deps.providerService,
      getAvailableProviders: async () => [
        { id: 'glm', name: 'GLM', models: [], available: true },
        { id: 'kimi', name: 'Kimi', models: [], available: true },
        { id: 'deepseek', name: 'DeepSeek', models: [], available: true },
      ],
      isProviderAvailable: async (id: string) => id === 'deepseek',
      applyEnvVarsToProcessForProvider: async (providerId: string, modelId: string) => {
        seenProviders.push(providerId);
        return originalApply(providerId, modelId);
      },
    };
    const classifier = new LimitErrorLlmClassifier('s1', { ...deps, excludeProvider: 'glm' });
    await classifier.classify('429 from glm via unavailable relay');
    expect(seenProviders).toEqual(['deepseek']);
  });

  it('returns null when no provider is available', async () => {
    const { deps } = createDeps('{"is_limit":true,"kind":"rate_limit","reset_at":1}');
    deps.providerService = {
      ...deps.providerService,
      getAvailableProviders: async () => [],
    };
    const classifier = new LimitErrorLlmClassifier('s1', deps);
    expect(await classifier.classify('429')).toBeNull();
  });
});
