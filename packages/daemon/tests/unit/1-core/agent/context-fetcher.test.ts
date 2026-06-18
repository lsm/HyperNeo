/**
 * ContextFetcher Tests
 *
 * Verifies the adapter that converts the SDK's
 * `query.getContextUsage()` response into NeoKai's `ContextInfo` shape.
 */

import { describe, it, expect, mock, spyOn } from 'bun:test';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { ContextFetcher } from '../../../../src/lib/agent/context-fetcher';

// Minimal typed helper so we don't have to re-declare the SDK response shape.
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
    expect(info.percentUsed).toBe(6); // Math.round(6.25) = 6
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
        { name: 'System prompt', tokens: 3600, color: 'gray' },
        { name: 'System tools', tokens: 18000, color: 'gray' },
        { name: 'Messages', tokens: 108, color: 'blue' },
        { name: 'Free space', tokens: 145300, color: 'gray-dim' },
      ],
    });

    const info = ContextFetcher.toContextInfo(response);

    expect(info.breakdown['System prompt']).toEqual({
      tokens: 3600,
      // 3600 / 200000 = 1.8%
      percent: 1.8,
    });
    expect(info.breakdown['System tools']).toEqual({
      tokens: 18000,
      // 18000 / 200000 = 9%
      percent: 9,
    });
    expect(info.breakdown['Messages']).toEqual({
      tokens: 108,
      // 108 / 200000 ≈ 0.054 → rounded to 1 decimal = 0.1
      percent: 0.1,
    });
    expect(info.breakdown['Free space']).toEqual({
      tokens: 145300,
      percent: 72.7,
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

  it('derives the threshold from reserved autocompact breakdown tokens', () => {
    const response = baseResponse({
      totalTokens: 226963,
      maxTokens: 200000,
      rawMaxTokens: 272000,
      percentage: 113.5,
      autoCompactThreshold: 180000,
      isAutoCompactEnabled: true,
      categories: [
        { name: 'Messages', tokens: 193926, color: 'blue' },
        { name: 'Reserved for Autocompact', tokens: 33037, color: 'gray' },
      ],
    });

    const info = ContextFetcher.toContextInfo(response);

    expect(info.totalCapacity).toBe(272000);
    expect(info.breakdown['Reserved for Autocompact']).toEqual({
      tokens: 33037,
      percent: 12.1,
    });
    expect(info.autoCompactThreshold).toBe(238963);
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
      alias: 'codex-latest',
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
    // Regression test for glm-5.2[1m][1m] causing 1M → 200K fallback.
    // The double suffix is normalized to glm-5.2[1m], which matches metadata
    // and returns 1M capacity instead of falling back to 200K.
    const response = baseResponse({
      totalTokens: 10000,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      percentage: 1,
      model: 'glm-5.2[1m][1m]', // Double suffix from accumulated routing
      categories: [{ name: 'Messages', tokens: 10000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'glm-5.2[1m]',
      provider: 'glm',
      preferContextWindowMetadata: true,
      contextWindow: 1_000_000,
    });

    // Normalized model ID should be glm-5.2[1m] (single suffix)
    expect(info.model).toBe('glm-5.2[1m]');
    // Should use 1M capacity from metadata, not 200K fallback
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
      alias: 'codex-latest',
      contextWindow: 272000,
      preferContextWindowMetadata: true,
    });

    expect(info.totalCapacity).toBe(272000);
    expect(info.percentUsed).toBe(50);
    expect(info.breakdown.Messages).toEqual({ tokens: 136000, percent: 50 });
    expect(info.autoCompactThreshold).toBe(244800);
  });

  it('matches GPT-5.1 mini SDK model names to Codex metadata aliases', () => {
    const response = baseResponse({
      totalTokens: 64000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 32,
      model: 'gpt-5.1-mini',
      autoCompactThreshold: 180000,
      isAutoCompactEnabled: true,
      categories: [{ name: 'Messages', tokens: 64000, color: 'blue' }],
    });

    const info = ContextFetcher.toContextInfo(response, {
      id: 'gpt-5.1-mini',
      alias: 'copilot-gpt-5-1-mini',
      contextWindow: 128000,
      preferContextWindowMetadata: true,
    });

    expect(info.totalCapacity).toBe(128000);
    expect(info.percentUsed).toBe(50);
    expect(info.breakdown.Messages).toEqual({ tokens: 64000, percent: 50 });
    expect(info.autoCompactThreshold).toBe(115200);
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
      id: 'kimi-for-coding',
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
    // SDK type says model is a string, but guard against runtime drift.
    const response = baseResponse({ model: '' });
    const info = ContextFetcher.toContextInfo(response);
    // Empty string is falsy so we coerce to null for consistency with ContextInfo.model.
    expect(info.model === null || info.model === '').toBe(true);
  });
});

describe('ContextFetcher.fetch', () => {
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

  describe('capacity mismatch warning', () => {
    it('warns when SDK effective capacity differs from metadata by >10% for NATIVE providers', async () => {
      // Simulates a glm-5.2[1m] regression: PP() would return 200k if the
      // SDK no longer recognises the [1m] suffix. With CLAUDE_CODE_AUTO_COMPACT_WINDOW
      // env=1M, effective window=min(200k, 1M)=200k. metadata=1M.
      // Mismatch = (1M - 200k) / 1M = 80% > 10% → warn.
      const getContextUsage = mock(async () =>
        baseResponse({
          totalTokens: 100_000,
          maxTokens: 200_000,
          rawMaxTokens: 1_000_000, // raw PP capacity — should NOT be used
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
      // The warning should reference the effective maxTokens (200k), not raw.
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

    it('does not warn for providers opted out of SDK auto-compact (Kimi)', async () => {
      // Kimi: PP() caps kimi-for-coding to 200k regardless of metadata.
      // Mismatch is the expected steady state — skip to avoid log noise.
      const getContextUsage = mock(async () =>
        baseResponse({
          totalTokens: 100_000,
          maxTokens: 200_000,
          rawMaxTokens: 200_000,
          model: 'kimi-for-coding',
        })
      );
      const query = { getContextUsage } as unknown as Query;

      const fetcher = new ContextFetcher('kimi-session');
      const warnSpy = spyOn(fetcher.logger, 'warn');

      await fetcher.fetch(query, {
        id: 'kimi-for-coding',
        contextWindow: 262_144,
        provider: 'kimi',
        preferContextWindowMetadata: true,
      });

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn for non-NATIVE providers (OpenRouter/Ollama/custom)', async () => {
      // For these providers, SDK PP() returns 200k for unknown models —
      // mismatch is the known steady state, not a regression.
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
      // Codex gpt-5.5: SDK reports real model ID with PP=272k (maxTokens).
      // Comparing effective vs metadata → no mismatch.
      const getContextUsage = mock(async () =>
        baseResponse({
          totalTokens: 100_000,
          maxTokens: 272_000, // effective
          rawMaxTokens: 272_000, // raw PP capacity — should NOT trigger warning
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
