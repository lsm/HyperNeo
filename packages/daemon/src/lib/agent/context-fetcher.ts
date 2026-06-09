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

import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type {
  ContextInfo,
  ContextCategoryBreakdown,
  ContextMessageBreakdown,
  ContextAPIUsage,
  ModelInfo,
} from '@neokai/shared';
import { Logger } from '../logger';

type ContextMetadata =
  | Pick<ModelInfo, 'id' | 'alias' | 'contextWindow' | 'preferContextWindowMetadata' | 'provider'>
  | null
  | undefined;

/** Providers whose SDK-reported context capacity is trustworthy. All others prefer metadata. */
const NATIVE_CONTEXT_WINDOW_PROVIDERS = new Set(['anthropic', 'anthropic-copilot']);

/** Generic SDK tier names that non-native providers map to via ANTHROPIC_DEFAULT_*_MODEL. */
const SDK_GENERIC_MODEL_IDS = new Set(['default', 'haiku', 'sonnet', 'opus']);

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export class ContextFetcher {
  private logger: Logger;

  constructor(private sessionId: string) {
    this.logger = new Logger(`ContextFetcher ${sessionId}`);
  }

  /**
   * Call the SDK's `getContextUsage()` and convert the result to `ContextInfo`.
   *
   * Returns null if the query handle is missing or the call fails. Failures
   * are logged at warn level rather than thrown, because context tracking is
   * a best-effort side effect of turn handling and should never cause a turn
   * to fail.
   */
  async fetch(query: Query | null, modelMetadata?: ContextMetadata): Promise<ContextInfo | null> {
    if (!query) return null;

    try {
      const response = await query.getContextUsage();
      return ContextFetcher.toContextInfo(response, modelMetadata);
    } catch (error) {
      this.logger.warn('query.getContextUsage() failed:', error);
      return null;
    }
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
    const responseModel = response.model || undefined;
    const isNativeProvider =
      modelMetadata?.provider && NATIVE_CONTEXT_WINDOW_PROVIDERS.has(modelMetadata.provider);
    const isGenericSdkModel = responseModel ? SDK_GENERIC_MODEL_IDS.has(responseModel) : false;
    const metadataMatchesResponse =
      !responseModel ||
      modelMetadata?.id === responseModel ||
      modelMetadata?.alias === responseModel ||
      (!isNativeProvider && isGenericSdkModel);
    const metadataCapacity = metadataMatchesResponse
      ? positiveInteger(modelMetadata?.contextWindow)
      : undefined;
    const shouldPreferMetadata = modelMetadata?.preferContextWindowMetadata ?? !isNativeProvider;
    const capacity =
      shouldPreferMetadata && metadataCapacity
        ? metadataCapacity
        : (sdkRawCapacity ?? sdkCapacity ?? metadataCapacity ?? 0);
    for (const category of response.categories ?? []) {
      // Compute percent relative to capacity (SDK response doesn't carry it).
      // Round to 1 decimal place to match the display the UI already expects.
      const percent = capacity > 0 ? Math.round((category.tokens / capacity) * 1000) / 10 : null;
      breakdown[category.name] = {
        tokens: category.tokens,
        percent,
      };
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

    return {
      model: response.model ?? null,
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
