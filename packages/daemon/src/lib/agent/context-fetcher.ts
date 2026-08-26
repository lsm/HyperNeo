import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type { QueryLike } from './query-like.ts';
import type {
  ContextInfo,
  ContextCategoryBreakdown,
  ContextMessageBreakdown,
  ContextAPIUsage,
  ModelInfo,
} from '@hyperneo/shared';
import { AUTO_COMPACT_PERCENT_DEFAULT, resolveAutoCompactPercent } from '@hyperneo/shared';
import { Logger } from '../logger.ts';
import { getModelInfo } from '../model-service.js';
import { scaledAutoCompactWindow } from './context-budget-decision.ts';
import {
  NATIVE_CONTEXT_WINDOW_PROVIDER_IDS,
  PROVIDER_NO_SDK_AUTO_COMPACT,
} from './query-options-builder.js';

type ContextMetadata =
  | Pick<
      ModelInfo,
      | 'id'
      | 'alias'
      | 'sdkModelIds'
      | 'contextWindow'
      | 'preferContextWindowMetadata'
      | 'autoCompactPercent'
      | 'provider'
    >
  | null
  | undefined;

const NATIVE_CONTEXT_WINDOW_PROVIDERS = new Set(['anthropic', 'anthropic-copilot']);

const SDK_GENERIC_MODEL_IDS = new Set(['default', 'haiku', 'sonnet', 'opus']);
const ONE_MILLION_CONTEXT_WINDOW = 1_000_000;
const ONE_MILLION_MODEL_SUFFIX = /\[1m\]$/i;

function normalizeModelId(modelId: string): string {
  return modelId.replace(/(\[1m\])+$/, '[1m]');
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function isAutocompactCategory(name: string): boolean {
  return name.toLowerCase().includes('autocompact');
}

function resolveDisplayModel(
  responseModel: string | undefined,
  modelMetadata: ContextMetadata,
  matchesSdkModelId: boolean,
  sdkCapacity: number | undefined
): string | undefined {
  if (!responseModel) return undefined;
  if (matchesSdkModelId && modelMetadata?.id) return modelMetadata.id;
  const metadataCapacity = positiveInteger(modelMetadata?.contextWindow);
  const isOneMillionWindow =
    metadataCapacity === ONE_MILLION_CONTEXT_WINDOW || sdkCapacity === ONE_MILLION_CONTEXT_WINDOW;
  if (ONE_MILLION_MODEL_SUFFIX.test(responseModel) && !isOneMillionWindow) {
    return responseModel.replace(ONE_MILLION_MODEL_SUFFIX, '');
  }
  return responseModel;
}

export class ContextFetcher {
  private logger: Logger;

  constructor(private sessionId: string) {
    this.logger = new Logger(`ContextFetcher ${sessionId}`);
  }

  private static readonly CAPACITY_MISMATCH_WARN_FRACTION = 0.1;

  async fetch(
    query: QueryLike | null,
    modelMetadata?: ContextMetadata
  ): Promise<ContextInfo | null> {
    if (!query?.getContextUsage) return null;

    try {
      const response = await ContextFetcher.withUsageTimeout(query.getContextUsage());
      const resolvedMetadata = await ContextFetcher.resolveMetadataForResponse(
        response,
        modelMetadata
      );
      const info = ContextFetcher.toContextInfo(response, resolvedMetadata);
      if (info) {
        ContextFetcher.warnOnCapacityMismatch(response, resolvedMetadata, this.logger);
      }
      return info;
    } catch (error) {
      this.logger.warn('query.getContextUsage() failed:', error);
      return null;
    }
  }

  private static async withUsageTimeout<T>(pending: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('getContextUsage timed out')), 2000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private static async resolveMetadataForResponse(
    response: SDKControlGetContextUsageResponse,
    modelMetadata: ContextMetadata
  ): Promise<ContextMetadata> {
    const providerId = modelMetadata?.provider;
    const responseModel = response.model ? normalizeModelId(response.model) : undefined;
    if (!providerId || !responseModel) return modelMetadata;

    const responseMetadata = await getModelInfo(responseModel, 'global', providerId);
    return responseMetadata ?? modelMetadata;
  }

  private static warnOnCapacityMismatch(
    response: SDKControlGetContextUsageResponse,
    modelMetadata: ContextMetadata,
    logger: Logger
  ): void {
    const providerId = modelMetadata?.provider;
    if (!providerId || !NATIVE_CONTEXT_WINDOW_PROVIDER_IDS.includes(providerId)) return;
    if (PROVIDER_NO_SDK_AUTO_COMPACT.has(providerId)) return;
    const metadataCapacity = positiveInteger(modelMetadata?.contextWindow);
    if (!metadataCapacity) return;
    const sdkCapacity = positiveInteger(response.maxTokens);
    if (!sdkCapacity) return;
    const larger = Math.max(sdkCapacity, metadataCapacity);
    if (larger <= 0) return;
    const mismatch = Math.abs(sdkCapacity - metadataCapacity) / larger;
    if (mismatch <= ContextFetcher.CAPACITY_MISMATCH_WARN_FRACTION) return;
    logger.warn(
      `Context capacity mismatch: SDK reports ${sdkCapacity} tokens for ` +
        `model=${response.model ?? '<unknown>'} but metadata declares ` +
        `${metadataCapacity} tokens (mismatch ${(mismatch * 100).toFixed(1)}%). ` +
        `Display will use metadata; SDK auto-compact may fire at the wrong threshold. ` +
        `Check PP() model recognition and CLAUDE_CODE_AUTO_COMPACT_WINDOW env var.`
    );
  }

  static toContextInfo(
    response: SDKControlGetContextUsageResponse,
    modelMetadata?: ContextMetadata
  ): ContextInfo {
    const breakdown: Record<string, ContextCategoryBreakdown> = {};
    const sdkRawCapacity = positiveInteger(response.rawMaxTokens);
    const sdkCapacity = positiveInteger(response.maxTokens);
    const rawResponseModel = response.model || undefined;
    const responseModel = rawResponseModel ? normalizeModelId(rawResponseModel) : undefined;
    const isNativeProvider =
      modelMetadata?.provider && NATIVE_CONTEXT_WINDOW_PROVIDERS.has(modelMetadata.provider);
    const isGenericSdkModel = responseModel ? SDK_GENERIC_MODEL_IDS.has(responseModel) : false;
    const sdkModelIds = modelMetadata?.sdkModelIds;
    const matchesSdkModelId =
      responseModel && sdkModelIds ? sdkModelIds.includes(responseModel) : false;
    const metadataMatchesResponse =
      !responseModel ||
      modelMetadata?.id === responseModel ||
      modelMetadata?.alias === responseModel ||
      matchesSdkModelId ||
      (!isNativeProvider && isGenericSdkModel);
    const metadataCapacity = metadataMatchesResponse
      ? positiveInteger(modelMetadata?.contextWindow)
      : undefined;
    const metadataCapacityAny = positiveInteger(modelMetadata?.contextWindow);
    const shouldPreferMetadata = modelMetadata?.preferContextWindowMetadata ?? !isNativeProvider;
    const hasStaleOneMillionSuffix =
      responseModel &&
      ONE_MILLION_MODEL_SUFFIX.test(responseModel) &&
      sdkCapacity !== undefined &&
      sdkCapacity < ONE_MILLION_CONTEXT_WINDOW;
    const sdkCapacityValue = hasStaleOneMillionSuffix
      ? sdkCapacity
      : (sdkRawCapacity ?? sdkCapacity);
    const sdkOverreporting =
      shouldPreferMetadata &&
      metadataCapacityAny !== undefined &&
      sdkCapacityValue !== undefined &&
      sdkCapacityValue > metadataCapacityAny;
    const sdkCapacityUnavailable =
      shouldPreferMetadata &&
      metadataCapacityAny !== undefined &&
      (sdkCapacityValue === undefined || sdkCapacityValue === 0);
    const useMetadata =
      (shouldPreferMetadata && metadataCapacity) || sdkOverreporting || sdkCapacityUnavailable;
    const capacity = useMetadata
      ? (metadataCapacityAny ?? 0)
      : (sdkCapacityValue ?? metadataCapacity ?? 0);
    for (const category of response.categories ?? []) {
      if (isAutocompactCategory(category.name)) continue;

      const percent = capacity > 0 ? Math.round((category.tokens / capacity) * 1000) / 10 : null;
      breakdown[category.name] = {
        tokens: category.tokens,
        percent,
      };
    }

    const usageEntries = Object.entries(breakdown)
      .filter(([name]) => !name.toLowerCase().includes('free space'))
      .map(([name, data]) => ({ name, tokens: data.tokens }));
    const totalUsageTokens = usageEntries.reduce((sum, entry) => sum + entry.tokens, 0);
    if (totalUsageTokens > 0) {
      const scaleFactor = response.totalTokens / totalUsageTokens;
      let normalizedSum = 0;
      for (const entry of usageEntries) {
        entry.tokens = Math.round(entry.tokens * scaleFactor);
        normalizedSum += entry.tokens;
      }
      const roundingError = response.totalTokens - normalizedSum;
      if (roundingError !== 0 && usageEntries.length > 0) {
        const largestEntry = usageEntries.reduce((max, entry) =>
          entry.tokens > max.tokens ? entry : max
        );
        largestEntry.tokens += roundingError;
      }
      for (const entry of usageEntries) {
        breakdown[entry.name] = {
          tokens: entry.tokens,
          percent: capacity > 0 ? Math.round((entry.tokens / capacity) * 1000) / 10 : null,
        };
      }
    }

    if (useMetadata && capacity > 0 && sdkCapacityValue !== capacity) {
      const autoCompactReservedTokens = (response.categories ?? []).find((category) =>
        isAutocompactCategory(category.name)
      )?.tokens;
      const reservedTokens =
        typeof autoCompactReservedTokens === 'number' && autoCompactReservedTokens > 0
          ? autoCompactReservedTokens
          : 0;
      const nonFreeSpaceTokens = Object.entries(breakdown)
        .filter(([name]) => !name.toLowerCase().includes('free space'))
        .reduce((sum, [, data]) => sum + data.tokens, 0);
      const freeSpaceKey = Object.keys(breakdown).find((name) =>
        name.toLowerCase().includes('free space')
      );
      if (freeSpaceKey) {
        const correctedTokens = Math.max(0, capacity - nonFreeSpaceTokens - reservedTokens);
        breakdown[freeSpaceKey] = {
          tokens: correctedTokens,
          percent: Math.round((correctedTokens / capacity) * 1000) / 10,
        };
      }
    }

    const apiUsage: ContextAPIUsage | undefined = response.apiUsage
      ? {
          inputTokens: response.apiUsage.input_tokens,
          outputTokens: response.apiUsage.output_tokens,
          cacheReadTokens: response.apiUsage.cache_read_input_tokens,
          cacheCreationTokens: response.apiUsage.cache_creation_input_tokens,
        }
      : undefined;

    const messageBreakdown: ContextMessageBreakdown | undefined = response.messageBreakdown
      ? {
          toolCallTokens: response.messageBreakdown.toolCallTokens,
          toolResultTokens: response.messageBreakdown.toolResultTokens,
          attachmentTokens: response.messageBreakdown.attachmentTokens,
          assistantMessageTokens: response.messageBreakdown.assistantMessageTokens,
          userMessageTokens: response.messageBreakdown.userMessageTokens,
          redirectedContextTokens: response.messageBreakdown.redirectedContextTokens,
          unattributedTokens: response.messageBreakdown.unattributedTokens,
          toolCallsByType: response.messageBreakdown.toolCallsByType,
          attachmentsByType: response.messageBreakdown.attachmentsByType,
        }
      : undefined;

    const percentUsed =
      capacity > 0
        ? Math.min(100, Math.max(0, Math.round((response.totalTokens / capacity) * 100)))
        : Math.max(0, Math.round(response.percentage));
    const rawSdkAutoCompactThreshold = response.autoCompactThreshold;
    let autoCompactThreshold = rawSdkAutoCompactThreshold;
    const autoCompactReservedTokens = (response.categories ?? []).find((category) =>
      isAutocompactCategory(category.name)
    )?.tokens;
    if (
      typeof autoCompactReservedTokens === 'number' &&
      autoCompactReservedTokens > 0 &&
      capacity > 0 &&
      autoCompactReservedTokens < capacity
    ) {
      autoCompactThreshold = capacity - autoCompactReservedTokens;
    } else if (
      typeof autoCompactThreshold === 'number' &&
      capacity > 0 &&
      response.maxTokens > 0 &&
      response.maxTokens !== capacity &&
      Math.abs(autoCompactThreshold - Math.floor(response.maxTokens * 0.9)) <= 1
    ) {
      autoCompactThreshold = Math.floor(capacity * 0.9);
    }
    const enforcementProvider = modelMetadata?.provider;
    let daemonBackstopActive = false;
    if (
      enforcementProvider &&
      !NATIVE_CONTEXT_WINDOW_PROVIDER_IDS.includes(enforcementProvider) &&
      !PROVIDER_NO_SDK_AUTO_COMPACT.has(enforcementProvider)
    ) {
      const budgetThreshold = scaledAutoCompactWindow(capacity, modelMetadata?.autoCompactPercent);
      if (
        budgetThreshold !== undefined &&
        budgetThreshold > 0 &&
        budgetThreshold <= capacity &&
        (resolveAutoCompactPercent(modelMetadata?.autoCompactPercent) >
          AUTO_COMPACT_PERCENT_DEFAULT ||
          response.isAutoCompactEnabled === false ||
          typeof autoCompactThreshold !== 'number' ||
          autoCompactThreshold > budgetThreshold)
      ) {
        autoCompactThreshold = budgetThreshold;
        daemonBackstopActive = true;
      }
    }

    const resolvedModel = resolveDisplayModel(
      responseModel,
      modelMetadata,
      matchesSdkModelId,
      sdkCapacity
    );

    return {
      model: resolvedModel ?? null,
      totalUsed: response.totalTokens,
      totalCapacity: capacity,
      percentUsed,
      breakdown,
      apiUsage,
      autoCompactThreshold,
      sdkAutoCompactThreshold: rawSdkAutoCompactThreshold,
      autoCompactPercent: modelMetadata?.autoCompactPercent,
      daemonBackstopActive,
      isAutoCompactEnabled: response.isAutoCompactEnabled,
      messageBreakdown,
      lastUpdated: Date.now(),
      source: 'sdk-get-context-usage',
    };
  }
}
