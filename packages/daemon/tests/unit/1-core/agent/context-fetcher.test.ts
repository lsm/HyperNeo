import { describe, it, expect, mock, spyOn, afterEach } from 'bun:test';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { ContextFetcher } from '../../../../src/lib/agent/context-fetcher';
import { setModelsCache } from '../../../../src/lib/model-service';

type SdkResponse = SDKControlGetContextUsageResponse;

function baseResponse(overrides: Partial<SdkResponse> = {}): SdkResponse {
  return {
    categories: [],
    totalTokens: 0,
    maxTokens: 200000,
    rawMaxTokens: 200000,
    percentage: 0,
    gridRows: [],
    model: 'claude-sonnet-4-6',
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: false,
    apiUsage: null,
    ...overrides,
  };
}

describe('ContextFetcher.toContextInfo', () => {
  it('maps the core fields (totalTokens/maxTokens/percentage/model)', () => {
    const response = baseResponse({
      totalTokens: 12500,
      maxTokens: 200000,
      percentage: 6.25,
      model: 'claude-sonnet-4-6',
    });

    const info = ContextFetcher.toContextInfo(response);

    expect(info.totalUsed).toBe(12500);
    expect(info.totalCapacity).toBe(200000);
    expect(info.percentUsed).toBe(6);
    expect(info.model).toBe('claude-sonnet-4-6');
    expect(info.source).toBe('sdk-get-context-usage');
    expect(info.lastUpdated).toBeGreaterThan(0);
  });

  it('flattens categories into breakdown with computed percentages', () => {
    const response = baseResponse({
      totalTokens: 20000,
      maxTokens: 200000,
      percentage: 10,
      categories: [
        { name: 'System prompt', tokens: 4000, color: 'gray' },
        { name: 'System tools', tokens: 15000, color: 'gray' },
        { name: 'Messages', tokens: 1000, color: 'blue' },
        { name: 'Free space', tokens: 180000, color: 'gray-dim' },
      ],
    });

    const info = ContextFetcher.toContextInfo(response);

    expect(info.breakdown['System prompt']).toEqual({
      tokens: 4000,
      percent: 2,
    });
    expect(info.breakdown['System tools']).toEqual({
      tokens: 15000,
      percent: 7.5,
    });
    expect(info.breakdown['Messages']).toEqual({
      tokens: 1000,
      percent: 0.5,
    });
    expect(info.breakdown['Free space']).toEqual({
      tokens: 180000,
      percent: 90,
    });
  });

  it('returns null percent when maxTokens is 0', () => {
    const response = baseResponse({
      totalTokens: 0,
      maxTokens: 0,
      rawMaxTokens: 0,
      percentage: 0,
      categories: [{ name: 'System prompt', tokens: 0, color: 'gray' }],
    });

    const info = ContextFetcher.toContextInfo(response);

    expect(info.totalCapacity).toBe(0);
    expect(info.breakdown['System prompt']?.percent).toBeNull();
  });

  it('produces empty breakdown when categories[] is empty', () => {
    const response = baseResponse({ categories: [] });

    const info = ContextFetcher.toContextInfo(response);

    expect(info.breakdown).toEqual({});
  });

  it('maps apiUsage snake_case → camelCase', () => {
    const response = baseResponse({
      apiUsage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 200,
      },
    });

    const info = ContextFetcher.toContextInfo(response);

    expect(info.apiUsage).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 100,
      cacheReadTokens: 200,
    });
  });

  it('leaves apiUsage undefined when SDK reports null', () => {
    const response = baseResponse({ apiUsage: null });
    const info = ContextFetcher.toContextInfo(response);
    expect(info.apiUsage).toBeUndefined();
  });

  it('passes through autoCompactThreshold and isAutoCompactEnabled', () => {
    const response = baseResponse({
      autoCompactThreshold: 160000,
      isAutoCompactEnabled: true,
    });

    const info = ContextFetcher.toContextInfo(response);

    expect(info.autoCompactThreshold).toBe(160000);
    expect(info.isAutoCompactEnabled).toBe(true);
  });

  it('uses rawMaxTokens and recomputes percentage when SDK percentage is inconsistent', () => {
    const response = baseResponse({
      totalTokens: 210000,
      maxTokens: 200000,
      rawMaxTokens: 272000,
      percentage: 140,
      autoCompactThreshold: 180000,
      isAutoCompactEnabled: true,
      categories: [{ name: 'Messages', tokens: 210000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response);

    expect(info.totalCapacity).toBe(272000);
    expect(info.percentUsed).toBe(77);
    expect(info.breakdown.Messages).toEqual({ tokens: 210000, percent: 77.2 });
    expect(info.autoCompactThreshold).toBe(244800);
  });

  it('derives the threshold from reserved autocompact breakdown tokens without including the buffer as a usage row', () => {
    const response = baseResponse({
      totalTokens: 226963,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 113.5,
      model: 'glm-5.1',
      autoCompactThreshold: 180000,
      isAutoCompactEnabled: true,
      categories: [
        { name: 'Messages', tokens: 193926, color: 'blue' },
        { name: 'Reserved for Autocompact', tokens: 33037, color: 'gray' },
        { name: 'Free space', tokens: 45037, color: 'gray-dim' },
      ],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'glm-5.1',
      alias: 'glm-5.1',
      contextWindow: 272000,
      provider: 'glm',
    });

    expect(info.totalCapacity).toBe(272000);
    expect(info.breakdown['Reserved for Autocompact']).toBeUndefined();
    expect(info.breakdown.Messages).toEqual({ tokens: 226963, percent: 83.4 });
    expect(info.breakdown['Free space']).toEqual({
      tokens: 12000,
      percent: 4.4,
    });
    expect(info.autoCompactThreshold).toBe(238963);
  });

  it('derives the threshold from the armed window for percent-configured endpoints, not raw capacity', () => {
    const response = baseResponse({
      totalTokens: 90000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 45,
      model: 'ce-model',
      autoCompactThreshold: 167000,
      isAutoCompactEnabled: true,
      categories: [
        { name: 'Messages', tokens: 90000, color: 'blue' },
        { name: 'Reserved for Autocompact', tokens: 33000, color: 'gray' },
        { name: 'Free space', tokens: 77000, color: 'gray-dim' },
      ],
    });

    const atFifty = ContextFetcher.toContextInfo(response, {
      id: 'ce-model',
      contextWindow: 200000,
      provider: 'custom-endpoint:test',
      autoCompactPercent: 50,
    });
    expect(atFifty.totalCapacity).toBe(200000);
    expect(atFifty.autoCompactThreshold).toBe(100000);
    expect(atFifty.daemonBackstopActive).toBe(true);
    expect(atFifty.sdkAutoCompactThreshold).toBe(167000);
    expect(atFifty.breakdown['Free space']).toEqual({ tokens: 10000, percent: 5 });

    const atNinety = ContextFetcher.toContextInfo(response, {
      id: 'ce-model',
      contextWindow: 200000,
      provider: 'custom-endpoint:test',
      autoCompactPercent: 90,
    });
    expect(atNinety.autoCompactThreshold).toBe(180000);
    expect(atNinety.breakdown['Free space']).toEqual({ tokens: 90000, percent: 45 });
  });

  it('treats a non-positive SDK auto-compact threshold as unknown and arms the backstop', () => {
    for (const autoCompactThreshold of [0, Number.NaN]) {
      const response = baseResponse({
        totalTokens: 90000,
        maxTokens: 200000,
        rawMaxTokens: 200000,
        percentage: 45,
        model: 'ce-model',
        autoCompactThreshold,
        isAutoCompactEnabled: true,
        categories: [{ name: 'Messages', tokens: 90000, color: 'blue' }],
      });

      const info = ContextFetcher.toContextInfo(response, {
        id: 'ce-model',
        contextWindow: 200000,
        provider: 'custom-endpoint:test',
      });

      expect(info.daemonBackstopActive).toBe(true);
      expect(info.autoCompactThreshold).toBe(180000);
    }
  });

  it('recalculates free space against the armed window when metadata capacity differs from SDK capacity', () => {
    const response = baseResponse({
      totalTokens: 90000,
      maxTokens: 160000,
      rawMaxTokens: 160000,
      percentage: 45,
      model: 'ce-model',
      autoCompactThreshold: 127000,
      isAutoCompactEnabled: true,
      categories: [
        { name: 'Messages', tokens: 90000, color: 'blue' },
        { name: 'Reserved for Autocompact', tokens: 33000, color: 'gray' },
        { name: 'Free space', tokens: 37000, color: 'gray-dim' },
      ],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'ce-model',
      contextWindow: 200000,
      provider: 'custom-endpoint:test',
      autoCompactPercent: 50,
    });

    expect(info.totalCapacity).toBe(200000);
    expect(info.autoCompactThreshold).toBe(100000);
    expect(info.breakdown['Free space']).toEqual({ tokens: 10000, percent: 5 });
  });

  it('uses Codex model metadata when SDK reports the Anthropic bridge alias', () => {
    const response = baseResponse({
      totalTokens: 136000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 68,
      model: 'gpt-5.5',
      autoCompactThreshold: 180000,
      isAutoCompactEnabled: true,
      categories: [{ name: 'Messages', tokens: 136000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'gpt-5.5',
      alias: 'codex-5.5',
      sdkModelIds: ['gpt-5.5'],
      contextWindow: 272000,
      preferContextWindowMetadata: true,
    });

    expect(info.totalCapacity).toBe(272000);
    expect(info.percentUsed).toBe(50);
    expect(info.breakdown.Messages).toEqual({ tokens: 136000, percent: 50 });
    expect(info.autoCompactThreshold).toBe(244800);
  });

  it('resolves SDK alias model name to canonical Codex model ID via sdkModelIds', () => {
    const response = baseResponse({
      totalTokens: 10000,
      maxTokens: 272000,
      rawMaxTokens: 272000,
      percentage: 4,
      model: 'gpt-5.5',
      categories: [{ name: 'Messages', tokens: 10000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'gpt-5.5',
      sdkModelIds: ['gpt-5.5'],
      provider: 'anthropic-codex',
      preferContextWindowMetadata: true,
      contextWindow: 272000,
    });

    expect(info.model).toBe('gpt-5.5');
    expect(info.totalCapacity).toBe(272000);
  });

  it('matches the Kimi k3-256k global SDK id via sdkModelIds for capacity', () => {
    const response = baseResponse({
      totalTokens: 10000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 5,
      model: 'kimi-k3-256k',
      categories: [{ name: 'Messages', tokens: 10000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'k3-256k',
      alias: 'k3-256k',
      sdkModelIds: ['kimi-k3-256k'],
      provider: 'kimi',
      preferContextWindowMetadata: true,
      contextWindow: 262144,
    });

    expect(info.totalCapacity).toBe(262144);
  });

  it('falls back to SDK capacity when the Kimi k3-256k global id is not registered', () => {
    const response = baseResponse({
      totalTokens: 10000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 5,
      model: 'kimi-k3-256k',
      categories: [{ name: 'Messages', tokens: 10000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'k3-256k',
      alias: 'k3-256k',
      provider: 'kimi',
      preferContextWindowMetadata: true,
      contextWindow: 262144,
    });

    expect(info.totalCapacity).toBe(200000);
  });

  it('keeps [1m] suffix in context display when effective capacity is 1M', () => {
    const response = baseResponse({
      totalTokens: 10000,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      percentage: 1,
      model: 'glm-5.2[1m]',
      categories: [{ name: 'Messages', tokens: 10000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'glm-5.2[1m]',
      provider: 'glm',
      preferContextWindowMetadata: true,
      contextWindow: 1_000_000,
    });

    expect(info.model).toBe('glm-5.2[1m]');
    expect(info.totalCapacity).toBe(1_000_000);
  });

  it('strips stale [1m] suffix from context display when effective capacity is below 1M', () => {
    const response = baseResponse({
      totalTokens: 10000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 5,
      model: 'glm-5.1[1m]',
      categories: [{ name: 'Messages', tokens: 10000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'glm-5.1',
      provider: 'glm',
      preferContextWindowMetadata: true,
      contextWindow: 200000,
    });

    expect(info.model).toBe('glm-5.1');
    expect(info.totalCapacity).toBe(200000);
  });

  it('strips stale [1m] suffix when raw capacity overreports but effective window is 200k', () => {
    const response = baseResponse({
      totalTokens: 10000,
      maxTokens: 200000,
      rawMaxTokens: 1_000_000,
      percentage: 5,
      model: 'glm-5.1[1m]',
      categories: [{ name: 'Messages', tokens: 10000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'glm-5.1',
      provider: 'glm',
      preferContextWindowMetadata: true,
      contextWindow: 200000,
    });

    expect(info.model).toBe('glm-5.1');
    expect(info.totalCapacity).toBe(200000);
  });

  it('ignores raw 1M capacity from stale [1m] suffix even without metadata', () => {
    const response = baseResponse({
      totalTokens: 10000,
      maxTokens: 200000,
      rawMaxTokens: 1_000_000,
      percentage: 5,
      model: 'glm-5.1[1m]',
      categories: [{ name: 'Messages', tokens: 10000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response);

    expect(info.model).toBe('glm-5.1');
    expect(info.totalCapacity).toBe(200000);
  });

  it('normalizes double [1m] suffix and uses 1M capacity from metadata', () => {
    const response = baseResponse({
      totalTokens: 10000,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      percentage: 1,
      model: 'glm-5.2[1m][1m]',
      categories: [{ name: 'Messages', tokens: 10000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'glm-5.2[1m]',
      provider: 'glm',
      preferContextWindowMetadata: true,
      contextWindow: 1_000_000,
    });

    expect(info.model).toBe('glm-5.2[1m]');
    expect(info.totalCapacity).toBe(1_000_000);
  });

  it('uses Codex model metadata when SDK reports the generic 200k capacity', () => {
    const response = baseResponse({
      totalTokens: 136000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 68,
      model: 'gpt-5.5',
      autoCompactThreshold: 180000,
      isAutoCompactEnabled: true,
      categories: [{ name: 'Messages', tokens: 136000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'gpt-5.5',
      alias: 'codex-5.5',
      contextWindow: 272000,
      preferContextWindowMetadata: true,
    });

    expect(info.totalCapacity).toBe(272000);
    expect(info.percentUsed).toBe(50);
    expect(info.breakdown.Messages).toEqual({ tokens: 136000, percent: 50 });
    expect(info.autoCompactThreshold).toBe(244800);
  });

  it('matches GPT-5.6 Sol SDK model names to Codex metadata aliases', () => {
    const response = baseResponse({
      totalTokens: 525000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 262.5,
      model: 'gpt-5.6-sol',
      autoCompactThreshold: 180000,
      isAutoCompactEnabled: true,
      categories: [{ name: 'Messages', tokens: 525000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'gpt-5.6-sol',
      alias: 'codex-latest',
      contextWindow: 1050000,
      preferContextWindowMetadata: true,
    });

    expect(info.totalCapacity).toBe(1050000);
    expect(info.percentUsed).toBe(50);
    expect(info.breakdown.Messages).toEqual({ tokens: 525000, percent: 50 });
    expect(info.autoCompactThreshold).toBe(945000);
  });

  it('prefers SDK capacity over session metadata for fallback model usage', () => {
    const response = baseResponse({
      totalTokens: 64000,
      maxTokens: 128000,
      rawMaxTokens: 128000,
      percentage: 50,
      model: 'gpt-5.4-mini',
      autoCompactThreshold: 115200,
      isAutoCompactEnabled: true,
      categories: [{ name: 'Messages', tokens: 64000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'gpt-5.5',
      contextWindow: 272000,
      preferContextWindowMetadata: true,
    });

    expect(info.totalCapacity).toBe(128000);
    expect(info.percentUsed).toBe(50);
    expect(info.breakdown.Messages).toEqual({ tokens: 64000, percent: 50 });
    expect(info.autoCompactThreshold).toBe(115200);
  });

  it('uses session metadata when SDK capacity is unavailable', () => {
    const response = baseResponse({
      totalTokens: 136000,
      maxTokens: 0,
      rawMaxTokens: 0,
      percentage: 68,
      model: 'gpt-5.5',
      autoCompactThreshold: 0,
      isAutoCompactEnabled: true,
      categories: [{ name: 'Messages', tokens: 136000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'gpt-5.5',
      contextWindow: 272000,
    });

    expect(info.totalCapacity).toBe(272000);
    expect(info.percentUsed).toBe(50);
    expect(info.breakdown.Messages).toEqual({ tokens: 136000, percent: 50 });
    expect(info.autoCompactThreshold).toBe(0);
  });

  it('does not use session metadata when SDK capacity is unavailable for a different active model on native providers', () => {
    const response = baseResponse({
      totalTokens: 64000,
      maxTokens: 0,
      rawMaxTokens: 0,
      percentage: 50,
      model: 'gpt-5.4-mini',
      autoCompactThreshold: 0,
      isAutoCompactEnabled: true,
      categories: [{ name: 'Messages', tokens: 64000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'gpt-5.5',
      contextWindow: 272000,
      provider: 'anthropic',
    });

    expect(info.totalCapacity).toBe(0);
    expect(info.percentUsed).toBe(50);
    expect(info.breakdown.Messages).toEqual({ tokens: 64000, percent: null });
    expect(info.autoCompactThreshold).toBe(0);
  });

  it('prefers non-native provider metadata even when SDK-reported model name differs', () => {
    const response = baseResponse({
      totalTokens: 50000,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      percentage: 5,
      model: 'upstream-mapped-id',
      categories: [{ name: 'Messages', tokens: 50000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'glm-5',
      alias: 'glm-5',
      contextWindow: 200000,
      provider: 'glm',
    });

    expect(info.totalCapacity).toBe(200000);
    expect(info.percentUsed).toBe(25);
    expect(info.breakdown.Messages).toEqual({ tokens: 50000, percent: 25 });
  });

  it('prefers metadata capacity for non-native providers when SDK reports a generic value', () => {
    const response = baseResponse({
      totalTokens: 50000,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      percentage: 5,
      model: 'glm-5.1',
      categories: [{ name: 'Messages', tokens: 50000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'glm-5.1',
      alias: 'glm-5.1',
      contextWindow: 200000,
      provider: 'glm',
    });

    expect(info.totalCapacity).toBe(200000);
    expect(info.percentUsed).toBe(25);
    expect(info.breakdown.Messages).toEqual({ tokens: 50000, percent: 25 });
  });

  it('recalculates free space when metadata capacity differs from SDK capacity', () => {
    const response = baseResponse({
      totalTokens: 127300,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      percentage: 12.7,
      model: 'glm-5.1',
      categories: [
        { name: 'System prompt', tokens: 3600, color: 'gray' },
        { name: 'System tools', tokens: 18000, color: 'gray' },
        { name: 'Messages', tokens: 105700, color: 'blue' },
        { name: 'Free space', tokens: 872700, color: 'gray-dim' },
      ],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'glm-5.1',
      alias: 'glm-5.1',
      contextWindow: 200000,
      provider: 'glm',
    });

    expect(info.totalCapacity).toBe(200000);
    expect(info.breakdown['Free space']).toEqual({ tokens: 72700, percent: 36.4 });
  });

  it('normalizes categories scaled to a larger SDK window so no usage category exceeds totalUsed', () => {
    const response = baseResponse({
      totalTokens: 90584,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      percentage: 9.1,
      model: 'kimi-k2.7-code',
      isAutoCompactEnabled: true,
      categories: [
        { name: 'System prompt', tokens: 12000, color: 'gray' },
        { name: 'Messages', tokens: 202700, color: 'blue' },
        { name: 'Reserved for Autocompact', tokens: 50000, color: 'gray' },
        { name: 'Free space', tokens: 744300, color: 'gray-dim' },
      ],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'kimi-k2.7-code',
      alias: 'kimi',
      contextWindow: 262144,
      provider: 'kimi',
    });

    expect(info.totalCapacity).toBe(262144);
    expect(info.totalUsed).toBe(90584);
    expect(info.breakdown['Reserved for Autocompact']).toBeUndefined();
    expect(info.autoCompactThreshold).toBe(235929);
    expect(info.daemonBackstopActive).toBe(true);
    expect(info.sdkAutoCompactThreshold).toBeFalsy();

    const nonFreeCategories = Object.entries(info.breakdown).filter(
      ([name]) => !name.toLowerCase().includes('free space')
    );
    const nonFreeSum = nonFreeCategories.reduce((sum, [, data]) => sum + data.tokens, 0);
    expect(nonFreeSum).toBe(info.totalUsed);
    for (const [, data] of nonFreeCategories) {
      expect(data.tokens).toBeLessThanOrEqual(info.totalUsed);
    }

    expect(info.breakdown['Free space'].tokens).toBe(121560);
  });

  it('keeps SDK free space when metadata matches SDK capacity', () => {
    const response = baseResponse({
      totalTokens: 127300,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      percentage: 12.7,
      model: 'glm-5.2',
      categories: [
        { name: 'System prompt', tokens: 3600, color: 'gray' },
        { name: 'System tools', tokens: 18000, color: 'gray' },
        { name: 'Messages', tokens: 105700, color: 'blue' },
        { name: 'Free space', tokens: 872700, color: 'gray-dim' },
      ],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'glm-5.2',
      alias: 'glm-5.2',
      contextWindow: 1000000,
      provider: 'glm',
    });

    expect(info.totalCapacity).toBe(1000000);
    expect(info.breakdown['Free space']).toEqual({ tokens: 872700, percent: 87.3 });
  });

  it('clamps recalculated free space to zero when usage exceeds metadata capacity', () => {
    const response = baseResponse({
      totalTokens: 250000,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      percentage: 25,
      model: 'glm-5.1',
      categories: [
        { name: 'System tools', tokens: 50000, color: 'gray' },
        { name: 'Messages', tokens: 200000, color: 'blue' },
        { name: 'Free space', tokens: 750000, color: 'gray-dim' },
      ],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'glm-5.1',
      alias: 'glm-5.1',
      contextWindow: 200000,
      provider: 'glm',
    });

    expect(info.breakdown['Free space']).toEqual({ tokens: 0, percent: 0 });
  });

  it('uses SDK capacity for native Anthropic providers even when metadata differs', () => {
    const response = baseResponse({
      totalTokens: 50000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 25,
      model: 'claude-sonnet-4-6',
      categories: [{ name: 'Messages', tokens: 50000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'claude-sonnet-4-6',
      alias: 'sonnet',
      contextWindow: 100000,
      provider: 'anthropic',
    });

    expect(info.totalCapacity).toBe(200000);
    expect(info.percentUsed).toBe(25);
    expect(info.breakdown.Messages).toEqual({ tokens: 50000, percent: 25 });
  });

  it('allows non-native providers to opt out of metadata via explicit flag', () => {
    const response = baseResponse({
      totalTokens: 50000,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      percentage: 5,
      model: 'custom-model',
      categories: [{ name: 'Messages', tokens: 50000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'custom-model',
      alias: 'custom-model',
      contextWindow: 200000,
      provider: 'custom:test',
      preferContextWindowMetadata: false,
    });

    expect(info.totalCapacity).toBe(1000000);
    expect(info.percentUsed).toBe(5);
    expect(info.breakdown.Messages).toEqual({ tokens: 50000, percent: 5 });
  });

  it('uses metadata for non-native providers when SDK reports generic placeholder model', () => {
    const response = baseResponse({
      totalTokens: 50000,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      percentage: 5,
      model: 'default',
      categories: [{ name: 'Messages', tokens: 50000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'glm-5.1',
      alias: 'glm-5.1',
      contextWindow: 200000,
      provider: 'glm',
    });

    expect(info.totalCapacity).toBe(200000);
    expect(info.percentUsed).toBe(25);
    expect(info.breakdown.Messages).toEqual({ tokens: 50000, percent: 25 });
  });

  it('uses metadata for non-native providers when SDK reports generic tier name', () => {
    const response = baseResponse({
      totalTokens: 50000,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      percentage: 5,
      model: 'sonnet',
      categories: [{ name: 'Messages', tokens: 50000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'kimi-k2.7-code',
      alias: 'kimi',
      contextWindow: 262144,
      provider: 'kimi',
    });

    expect(info.totalCapacity).toBe(262144);
    expect(info.percentUsed).toBe(19);
    expect(info.breakdown.Messages).toEqual({ tokens: 50000, percent: 19.1 });
  });

  it('still prefers SDK capacity for native providers when SDK reports generic placeholder', () => {
    const response = baseResponse({
      totalTokens: 50000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 25,
      model: 'default',
      categories: [{ name: 'Messages', tokens: 50000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'claude-sonnet-4-6',
      alias: 'sonnet',
      contextWindow: 100000,
      provider: 'anthropic',
    });

    expect(info.totalCapacity).toBe(200000);
    expect(info.percentUsed).toBe(25);
    expect(info.breakdown.Messages).toEqual({ tokens: 50000, percent: 25 });
  });

  it('caps recomputed percentUsed at 100 when usage exceeds capacity', () => {
    const response = baseResponse({
      totalTokens: 300000,
      maxTokens: 200000,
      rawMaxTokens: 272000,
      percentage: 150,
    });

    const info = ContextFetcher.toContextInfo(response);

    expect(info.percentUsed).toBe(100);
  });

  it('passes through messageBreakdown when present', () => {
    const response = baseResponse({
      messageBreakdown: {
        toolCallTokens: 100,
        toolResultTokens: 200,
        attachmentTokens: 50,
        assistantMessageTokens: 300,
        userMessageTokens: 75,
        redirectedContextTokens: 12,
        unattributedTokens: 7,
        toolCallsByType: [{ name: 'Read', callTokens: 50, resultTokens: 100 }],
        attachmentsByType: [{ name: 'image', tokens: 50 }],
      },
    });

    const info = ContextFetcher.toContextInfo(response);

    expect(info.messageBreakdown).toEqual({
      toolCallTokens: 100,
      toolResultTokens: 200,
      attachmentTokens: 50,
      assistantMessageTokens: 300,
      userMessageTokens: 75,
      redirectedContextTokens: 12,
      unattributedTokens: 7,
      toolCallsByType: [{ name: 'Read', callTokens: 50, resultTokens: 100 }],
      attachmentsByType: [{ name: 'image', tokens: 50 }],
    });
  });

  it('leaves messageBreakdown undefined when SDK omits it', () => {
    const response = baseResponse();
    const info = ContextFetcher.toContextInfo(response);
    expect(info.messageBreakdown).toBeUndefined();
  });

  it('handles missing model field', () => {
    const response = baseResponse({ model: '' });
    const info = ContextFetcher.toContextInfo(response);
    expect(info.model === null || info.model === '').toBe(true);
  });
});

describe('ContextFetcher.fetch', () => {
  afterEach(() => {
    setModelsCache(new Map());
  });

  it('returns null when query is null', async () => {
    const fetcher = new ContextFetcher('test-session');
    const result = await fetcher.fetch(null);
    expect(result).toBeNull();
  });

  it('calls query.getContextUsage() and returns a mapped ContextInfo', async () => {
    const sdkResponse = baseResponse({
      totalTokens: 5000,
      maxTokens: 200000,
      percentage: 2.5,
    });
    const getContextUsage = mock(async () => sdkResponse);
    const query = { getContextUsage } as unknown as Query;

    const fetcher = new ContextFetcher('test-session');
    const info = await fetcher.fetch(query);

    expect(getContextUsage).toHaveBeenCalledTimes(1);
    expect(info).not.toBeNull();
    expect(info?.totalUsed).toBe(5000);
    expect(info?.totalCapacity).toBe(200000);
    expect(info?.source).toBe('sdk-get-context-usage');
  });

  it('uses model metadata while fetching context usage when SDK capacity is unavailable', async () => {
    const sdkResponse = baseResponse({
      totalTokens: 136000,
      maxTokens: 0,
      rawMaxTokens: 0,
      model: 'gpt-5.5',
      autoCompactThreshold: 0,
      isAutoCompactEnabled: true,
    });
    const getContextUsage = mock(async () => sdkResponse);
    const query = { getContextUsage } as unknown as Query;

    const fetcher = new ContextFetcher('test-session');
    const info = await fetcher.fetch(query, {
      id: 'gpt-5.5',
      contextWindow: 272000,
    });

    expect(info?.totalCapacity).toBe(272000);
    expect(info?.autoCompactThreshold).toBe(0);
  });

  it('returns null (does not throw) when the SDK call rejects', async () => {
    const getContextUsage = mock(async () => {
      throw new Error('SDK not initialized');
    });
    const query = { getContextUsage } as unknown as Query;

    const fetcher = new ContextFetcher('test-session');
    const info = await fetcher.fetch(query);

    expect(info).toBeNull();
  });

  it('keeps the selected model metadata when the SDK reports a generic alias for a non-native provider', async () => {
    setModelsCache(
      new Map([
        [
          'global',
          [
            {
              id: 'default',
              name: 'Default',
              provider: 'custom-endpoint:test',
              contextWindow: 200000,
              autoCompactPercent: 90,
              available: true,
            },
          ],
        ],
      ])
    );
    const getContextUsage = mock(async () =>
      baseResponse({
        totalTokens: 90000,
        maxTokens: 200000,
        percentage: 45,
        model: 'default',
        autoCompactThreshold: 167000,
        isAutoCompactEnabled: true,
        categories: [
          { name: 'Messages', tokens: 90000, color: 'blue' },
          { name: 'Reserved for Autocompact', tokens: 33000, color: 'gray' },
          { name: 'Free space', tokens: 77000, color: 'gray-dim' },
        ],
      })
    );
    const query = { getContextUsage } as unknown as Query;

    const fetcher = new ContextFetcher('test-session');
    const info = await fetcher.fetch(query, {
      id: 'selected-model',
      contextWindow: 200000,
      provider: 'custom-endpoint:test',
      autoCompactPercent: 50,
    });

    expect(info?.autoCompactThreshold).toBe(100000);
    expect(info?.breakdown['Free space']).toEqual({ tokens: 10000, percent: 5 });
  });

  it('returns null when the SDK usage call never resolves', async () => {
    const getContextUsage = mock(() => new Promise(() => {}));
    const query = { getContextUsage } as unknown as Query;

    const fetcher = new ContextFetcher('test-session');
    const startedAt = Date.now();
    const info = await fetcher.fetch(query);

    expect(info).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(15000);
  }, 20000);

  it('returns null when getContextUsage throws synchronously', async () => {
    const getContextUsage = mock(() => {
      throw new Error('query closed');
    });
    const query = { getContextUsage } as unknown as Query;

    const fetcher = new ContextFetcher('throwing-session');
    const info = await fetcher.fetch(query);

    expect(info).toBeNull();
    const second = await fetcher.fetch(query);
    expect(second).toBeNull();
  });

  it('de-duplicates concurrent usage requests while one is pending', async () => {
    let resolveUsage: (value: ReturnType<typeof baseResponse>) => void = () => {};
    const getContextUsage = mock(
      () =>
        new Promise((resolve) => {
          resolveUsage = resolve;
        })
    );
    const query = { getContextUsage } as unknown as Query;

    const fetcher = new ContextFetcher('dedupe-session');
    const first = fetcher.fetch(query);
    const second = await fetcher.fetch(query);

    expect(getContextUsage).toHaveBeenCalledTimes(1);
    expect(second).toBeNull();

    resolveUsage(baseResponse({ totalTokens: 1000, maxTokens: 200000, percentage: 0.5 }));
    const info = await first;
    expect(info?.totalUsed).toBe(1000);
  });

  it('issues a fresh usage request after a pending one goes stale', async () => {
    const getContextUsage = mock(() => new Promise(() => {}));
    const query = { getContextUsage } as unknown as Query;

    const fetcher = new ContextFetcher('stale-session');
    fetcher.overrideUsageRequestStaleMsForTest(20);
    void fetcher.fetch(query);

    const deduped = await fetcher.fetch(query);
    expect(deduped).toBeNull();
    expect(getContextUsage).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 25));

    const recovered = await fetcher.fetch(query);
    expect(getContextUsage).toHaveBeenCalledTimes(2);
    expect(recovered).toBeNull();
  }, 20000);

  describe('capacity mismatch warning', () => {
    it('warns when SDK effective capacity differs from metadata by >10% for NATIVE providers', async () => {
      const getContextUsage = mock(async () =>
        baseResponse({
          totalTokens: 100_000,
          maxTokens: 200_000,
          rawMaxTokens: 1_000_000,
          model: 'glm-5.2[1m]',
        })
      );
      const query = { getContextUsage } as unknown as Query;

      const fetcher = new ContextFetcher('mismatch-session');
      const warnSpy = spyOn(fetcher.logger, 'warn');

      await fetcher.fetch(query, {
        id: 'glm-5.2[1m]',
        contextWindow: 1_000_000,
        provider: 'glm',
        preferContextWindowMetadata: true,
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message] = warnSpy.mock.calls[0] as unknown[];
      expect(String(message)).toContain('Context capacity mismatch');
      expect(String(message)).toContain('reports 200000');
      expect(String(message)).toContain('1000000');
    });

    it('does not warn when SDK effective capacity matches metadata within 10%', async () => {
      const getContextUsage = mock(async () =>
        baseResponse({
          totalTokens: 10_000,
          maxTokens: 210_000,
          rawMaxTokens: 210_000,
        })
      );
      const query = { getContextUsage } as unknown as Query;

      const fetcher = new ContextFetcher('match-session');
      const warnSpy = spyOn(fetcher.logger, 'warn');

      await fetcher.fetch(query, {
        id: 'some-model',
        contextWindow: 200_000,
        provider: 'glm',
      });

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('resolves metadata from the SDK-reported model before warning', async () => {
      const getContextUsage = mock(async () =>
        baseResponse({
          totalTokens: 10_000,
          maxTokens: 1_000_000,
          rawMaxTokens: 1_000_000,
          model: 'glm-5.2[1m]',
        })
      );
      const query = { getContextUsage } as unknown as Query;

      const fetcher = new ContextFetcher('stale-session-metadata-session');
      const warnSpy = spyOn(fetcher.logger, 'warn');

      const info = await fetcher.fetch(query, {
        id: 'glm-5',
        contextWindow: 200_000,
        provider: 'glm',
        preferContextWindowMetadata: true,
      });

      expect(info?.totalCapacity).toBe(1_000_000);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn when metadata is missing', async () => {
      const getContextUsage = mock(async () => baseResponse({ maxTokens: 200_000 }));
      const query = { getContextUsage } as unknown as Query;

      const fetcher = new ContextFetcher('no-metadata-session');
      const warnSpy = spyOn(fetcher.logger, 'warn');

      await fetcher.fetch(query);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn when SDK effective capacity is zero or unavailable', async () => {
      const getContextUsage = mock(async () =>
        baseResponse({
          maxTokens: 0,
          rawMaxTokens: 1_000_000,
        })
      );
      const query = { getContextUsage } as unknown as Query;

      const fetcher = new ContextFetcher('no-sdk-capacity-session');
      const warnSpy = spyOn(fetcher.logger, 'warn');

      await fetcher.fetch(query, {
        id: 'some-model',
        contextWindow: 1_000_000,
        provider: 'glm',
      });

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn for Kimi because it is not in native mismatch diagnostics', async () => {
      const getContextUsage = mock(async () =>
        baseResponse({
          totalTokens: 100_000,
          maxTokens: 200_000,
          rawMaxTokens: 200_000,
          model: 'kimi-k2.7-code',
        })
      );
      const query = { getContextUsage } as unknown as Query;

      const fetcher = new ContextFetcher('kimi-session');
      const warnSpy = spyOn(fetcher.logger, 'warn');

      await fetcher.fetch(query, {
        id: 'kimi-k2.7-code',
        contextWindow: 262_144,
        provider: 'kimi',
        preferContextWindowMetadata: true,
      });

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn for non-NATIVE providers (OpenRouter/Ollama/custom)', async () => {
      const getContextUsage = mock(async () =>
        baseResponse({
          totalTokens: 100_000,
          maxTokens: 200_000,
          rawMaxTokens: 200_000,
          model: 'deepseek-v4',
        })
      );
      const query = { getContextUsage } as unknown as Query;

      const fetcher = new ContextFetcher('openrouter-session');
      const warnSpy = spyOn(fetcher.logger, 'warn');

      await fetcher.fetch(query, {
        id: 'deepseek-v4',
        contextWindow: 1_000_000,
        provider: 'openrouter',
        preferContextWindowMetadata: true,
      });

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn for Codex when SDK effective window matches metadata', async () => {
      const getContextUsage = mock(async () =>
        baseResponse({
          totalTokens: 100_000,
          maxTokens: 272_000,
          rawMaxTokens: 272_000,
          model: 'gpt-5.5',
        })
      );
      const query = { getContextUsage } as unknown as Query;

      const fetcher = new ContextFetcher('codex-session');
      const warnSpy = spyOn(fetcher.logger, 'warn');

      await fetcher.fetch(query, {
        id: 'gpt-5.5',
        contextWindow: 272_000,
        provider: 'anthropic-codex',
        preferContextWindowMetadata: true,
      });

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
