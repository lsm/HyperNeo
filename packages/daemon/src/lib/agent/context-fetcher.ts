/**
 * ContextFetcher - Fetch context usage from the Claude Agent SDK
 *
 * Uses the native `query.getContextUsage()` method to get a typed breakdown
 * of the current context window:
 * - Category tokens (system prompt, system tools, messages, free space, etc.)
 * - Per-MCP-tool and memory-file token usage
 * - Auto-compact threshold and per-message breakdown
 *
 * This replaces the legacy approach that parsed `/context` slash-command
 * markdown output with regex. The SDK method returns a stable,
 * fully typed `SDKControlGetContextUsageResponse`.
 */

import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type { QueryLike } from './query-like';
import type {
  ContextInfo,
  ContextCategoryBreakdown,
  ContextMessageBreakdown,
  ContextAPIUsage,
  ModelInfo,
} from '@neokai/shared';
import { Logger } from '../logger';
import {
  NATIVE_CONTEXT_WINDOW_PROVIDER_IDS,
  PROVIDER_NO_SDK_AUTO_COMPACT,
} from './query-options-builder.js';

type ContextMetadata =
  | Pick<
      ModelInfo,
      'id' | 'alias' | 'sdkModelIds' | 'contextWindow' | 'preferContextWindowMetadata' | 'provider'
    >
  | null
  | undefined;

/** Providers whose SDK-reported context capacity is trustworthy. All others prefer metadata. */
const NATIVE_CONTEXT_WINDOW_PROVIDERS = new Set(['anthropic', 'anthropic-copilot']);

/** Generic SDK tier names that non-native providers map to via ANTHROPIC_DEFAULT_*_MODEL. */
const SDK_GENERIC_MODEL_IDS = new Set(['default', 'haiku', 'sonnet', 'opus']);
const ONE_MILLION_CONTEXT_WINDOW = 1_000_000;
const ONE_MILLION_MODEL_SUFFIX = /\[1m\]$/i;

/**
 * Normalize a model ID by stripping duplicate trailing [1m] suffixes.
 * Collapses glm-5.2[1m][1m] → glm-5.2[1m], glm-5.2[1m] → glm-5.2[1m].
 * Used before metadata lookups to handle sessions with accumulated suffixes.
 */
function normalizeModelId(modelId: string): string {
  return modelId.replace(/(\[1m\])+$/, '[1m]');
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
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

  /**
   * Fraction above which a mismatch between the SDK-reported context capacity
   * and the provider metadata is considered suspicious. The Claude Agent SDK's
   * PP() helper hardcodes a 200k fallback for unknown model IDs; for providers
   * whose real window differs from that fallback by more than this fraction
   * (e.g. GLM-5.2[1m] at 1M, Kimi at 262k), we want a runtime breadcrumb in the
   * daemon log so a regression in `[1m]` suffix recognition or env var plumbing
   * is visible without having to attach a debugger.
   */
  private static readonly CAPACITY_MISMATCH_WARN_FRACTION = 0.1;

  /**
   * Call the SDK's `getContextUsage()` and convert the result to `ContextInfo`.
   *
   * Returns null if the query handle is missing or the call fails. Failures
   * are logged at warn level rather than thrown, because context tracking is
   * a best-effort side effect of turn handling and should never cause a turn
   * to fail.
   */
  async fetch(
    query: QueryLike | null,
    modelMetadata?: ContextMetadata
  ): Promise<ContextInfo | null> {
    if (!query?.getContextUsage) return null;

    try {
      const response = await query.getContextUsage();
      const info = ContextFetcher.toContextInfo(response, modelMetadata);
      if (info) {
        ContextFetcher.warnOnCapacityMismatch(response, modelMetadata, this.logger);
      }
      return info;
    } catch (error) {
      this.logger.warn('query.getContextUsage() failed:', error);
      return null;
    }
  }

  /**
   * Log a warning when the SDK-reported capacity disagrees with provider
   * metadata by more than `CAPACITY_MISMATCH_WARN_FRACTION`. This surfaces
   * regressions in the SDK's PP() recognition of `[1m]` suffixes, env var
   * plumbing for `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, or any other path that
   * would silently make the SDK use the wrong context window.
   *
   * The check is purely diagnostic — `toContextInfo` already overrides the
   * SDK value with metadata when `preferContextWindowMetadata` is set, so the
   * display layer is unaffected. The warning is for operator visibility.
   */
  private static warnOnCapacityMismatch(
    response: SDKControlGetContextUsageResponse,
    modelMetadata: ContextMetadata,
    logger: Logger
  ): void {
    const providerId = modelMetadata?.provider;
    // Only fire for providers where we expect SDK auto-compact to work
    // correctly. This is the set in NATIVE_CONTEXT_WINDOW_PROVIDER_IDS
    // (anthropic, anthropic-copilot, anthropic-codex, glm). For everyone else
    // — OpenRouter/Ollama/custom (PP() returns 200k for unknown models so the
    // SDK's effective window is often wrong) — the mismatch is the known steady
    // state, not a regression, and logging it on every context refresh is pure
    // noise.
    if (!providerId || !NATIVE_CONTEXT_WINDOW_PROVIDER_IDS.includes(providerId)) return;
    if (PROVIDER_NO_SDK_AUTO_COMPACT.has(providerId)) return;
    const metadataCapacity = positiveInteger(modelMetadata?.contextWindow);
    if (!metadataCapacity) return;
    // Use the SDK's *effective* window (maxTokens), not the raw capacity
    // (rawMaxTokens). Some providers may report a different raw capacity than
    // their effective window (e.g., due to SDK-side clamping or overrides).
    // Comparing raw vs metadata would fire false-positive warnings.
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

  /**
   * Convert an SDK `getContextUsage()` response into NeoKai's `ContextInfo`.
   *
   * Mapping rules:
   * - `totalTokens → totalUsed`, `rawMaxTokens/maxTokens → totalCapacity`,
   *   recomputed percentage → percentUsed, `model → model`
   * - `categories[] → breakdown` (flattened into `Record<name, {tokens, percent}>`);
   *   percentages are recomputed relative to capacity because the SDK
   *   response doesn't include them per-category.
   * - `apiUsage` on the SDK response (which uses snake_case) is mapped to
   *   our camelCase `ContextAPIUsage` shape.
   * - `autoCompactThreshold`, `isAutoCompactEnabled`, and `messageBreakdown`
   *   pass through as optional fields.
   */
  static toContextInfo(
    response: SDKControlGetContextUsageResponse,
    modelMetadata?: ContextMetadata
  ): ContextInfo {
    const breakdown: Record<string, ContextCategoryBreakdown> = {};
    const sdkRawCapacity = positiveInteger(response.rawMaxTokens);
    const sdkCapacity = positiveInteger(response.maxTokens);
    // Normalize model ID to handle double [1m] suffixes (e.g. glm-5.2[1m][1m] → glm-5.2[1m])
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
    // For non-native providers the SDK's capacity is often a generic fallback
    // (1 M, 200 k, etc.) that doesn't reflect the upstream model's real limit.
    // When the SDK reports a capacity larger than the provider's metadata, or
    // when the SDK capacity is unavailable, trust metadata even if the response
    // model name doesn't exactly match. Native Anthropic providers keep the
    // exact-match safety guard so fallback/switched models don't display stale
    // metadata.
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
      // Compute percent relative to capacity (SDK response doesn't carry it).
      // Round to 1 decimal place to match the display the UI already expects.
      const percent = capacity > 0 ? Math.round((category.tokens / capacity) * 1000) / 10 : null;
      breakdown[category.name] = {
        tokens: category.tokens,
        percent,
      };
    }

    if (useMetadata && capacity > 0 && sdkCapacityValue !== capacity) {
      const nonFreeSpaceTokens = Object.entries(breakdown)
        .filter(([name]) => !name.toLowerCase().includes('free space'))
        .reduce((sum, [, data]) => sum + data.tokens, 0);
      const freeSpaceKey = Object.keys(breakdown).find((name) =>
        name.toLowerCase().includes('free space')
      );
      if (freeSpaceKey) {
        const correctedTokens = Math.max(0, capacity - nonFreeSpaceTokens);
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
    let autoCompactThreshold = response.autoCompactThreshold;
    const autoCompactReservedTokens = (response.categories ?? []).find((category) =>
      category.name.toLowerCase().includes('autocompact')
    )?.tokens;
    if (
      typeof autoCompactReservedTokens === 'number' &&
      autoCompactReservedTokens > 0 &&
      capacity > 0 &&
      autoCompactReservedTokens < capacity
    ) {
      // The SDK breakdown reports the autocompact row as reserved/free buffer
      // tokens. Convert that to the used-token threshold so the bar and the
      // breakdown share the same capacity denominator and visual percentage.
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
      isAutoCompactEnabled: response.isAutoCompactEnabled,
      messageBreakdown,
      lastUpdated: Date.now(),
      source: 'sdk-get-context-usage',
    };
  }
}
