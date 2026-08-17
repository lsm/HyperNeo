/**
 * Anthropic Provider - Official Anthropic Claude API
 *
 * This provider uses the standard Claude Agent SDK with Anthropic's API.
 * No special configuration needed - the SDK handles everything.
 */

import type { QueryLike } from '../agent/query-like';
import type {
  Provider,
  ProviderAuthStatusInfo,
  ProviderCapabilities,
  ProviderCredentials,
  ProviderSdkConfig,
  ModelTier,
} from '@hyperneo/shared/provider';
import type { ModelInfo } from '@hyperneo/shared';
import { resolveSDKCliPath, isRunningUnderBun } from '../agent/sdk-cli-resolver.js';
import { withSdkTranscriptRetention } from '../agent/sdk-transcript-retention';

/**
 * Canonical SDK model IDs (short-form IDs preferred by the SDK)
 * These are the preferred IDs that should be kept when duplicates exist
 * Note: 'default' is included because SDK still returns it, but it's converted to 'sonnet'
 */
const CANONICAL_SDK_IDS = new Set(['default', 'sonnet', 'opus', 'haiku', 'fable', 'sonnet[1m]']);

/**
 * Detect whether an SDK-reported model value belongs to Anthropic.
 *
 * The Claude Agent SDK queries whatever endpoint `ANTHROPIC_BASE_URL` points
 * at. When that variable is overridden — either by the user (e.g. routing
 * Anthropic traffic to a compatible provider like GLM) or by a previous
 * provider session that mutated `process.env` — the SDK may return non-Claude
 * model IDs (e.g. `glm-5`). Without this guard, those foreign IDs would be
 * tagged with `provider: 'anthropic'` in `convertSdkModels` and surface in the
 * UI under the Anthropic group, even though they belong to another provider.
 *
 * Accept only:
 *   - canonical SDK short IDs (`sonnet`, `opus`, `haiku`, `fable`, `default`, `sonnet[1m]`)
 *   - full Claude IDs (`claude-*`)
 */
function isAnthropicSdkModelId(modelId: string): boolean {
  if (CANONICAL_SDK_IDS.has(modelId)) return true;
  return modelId.toLowerCase().startsWith('claude-');
}

/**
 * Detect if a model ID is a full version-specific ID (e.g., claude-sonnet-4-5-20250929)
 * vs a canonical short ID (e.g., sonnet, opus, haiku)
 */
function isFullVersionId(modelId: string): boolean {
  // Full IDs match pattern: claude-{family}-{version}-{date}
  // e.g., claude-sonnet-4-5-20250929, claude-opus-4-5-20251101
  return /^claude-(sonnet|opus|haiku|fable)-[\d-]+$/.test(modelId);
}

/**
 * Extract version from SDK model description
 * SDK descriptions follow format: "{Family} {Version} · {description}"
 * Example: "Opus 4.6 · Most capable for complex work"
 * @returns Version string (e.g., "4.6") or null if not found
 */
function extractVersionFromDescription(description: string): string | null {
  // Match pattern: word + space + version number (e.g., "Opus 4.6")
  // Handles: "Opus 4.6", "Sonnet 4.5", "Haiku 4.5", etc.
  const match = description.match(/(?:Opus|Sonnet|Haiku|Fable)\s+(\d+\.\d+)/i);
  return match ? match[1] : null;
}

/**
 * Extract model family and version from a model ID and optional description
 * Returns null if not a recognizable Claude model
 * @param modelId - Model identifier (e.g., 'opus', 'claude-sonnet-4-5-20250929')
 * @param description - Optional SDK description to extract version from
 */
function parseModelId(
  modelId: string,
  description?: string
): { family: string; version?: string } | null {
  // Canonical short IDs - extract version from description if available
  const canonicalFamilies: Record<string, string> = {
    sonnet: 'sonnet',
    default: 'sonnet', // Legacy: map 'default' to sonnet
    opus: 'opus',
    haiku: 'haiku',
    fable: 'fable',
    'sonnet[1m]': 'sonnet',
  };

  if (modelId in canonicalFamilies) {
    const family = canonicalFamilies[modelId];
    // Try to extract version from description first
    const version = description ? extractVersionFromDescription(description) : null;
    // Add suffix for special variants
    const versionSuffix = modelId === 'sonnet[1m]' ? '-1m' : '';
    return {
      family,
      version: version ? `${version}${versionSuffix}` : undefined,
    };
  }

  // Full version IDs: claude-{family}-{major}-{minor}-{date}
  // Example: claude-sonnet-4-5-20250929
  const match = modelId.match(/^claude-(sonnet|opus|haiku|fable)-(\d+)-(\d+)(?:-\d{8})?$/);
  if (match) {
    const family = match[1];
    const major = match[2];
    const minor = match[3];
    return {
      family,
      version: `${major}.${minor}`, // Extract version as "4.5"
    };
  }

  return null;
}

/**
 * Anthropic provider implementation
 */
export class AnthropicProvider implements Provider {
  readonly id = 'anthropic';
  readonly displayName = 'Anthropic';

  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    extendedThinking: true,
    thinkingModes: 'granular',
    maxContextWindow: 200000,
    functionCalling: true,
    vision: true,
  };

  /**
   * Cache for dynamically loaded models
   */
  private modelCache: ModelInfo[] | null = null;
  private credentials: ProviderCredentials | null = null;
  private readonly capturedAnthropicBaseUrl: string | undefined;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly modelCacheKey: string = 'anthropic-global'
  ) {
    this.capturedAnthropicBaseUrl = env.ANTHROPIC_BASE_URL;
  }

  setCredentials(credentials: ProviderCredentials): void {
    this.credentials = credentials;
  }

  getCredentials(): ProviderCredentials | null {
    return this.credentials;
  }

  /**
   * Check if Anthropic is available
   * Requires ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or ANTHROPIC_AUTH_TOKEN
   */
  isAvailable(): boolean {
    return !!this.getApiKey();
  }

  /**
   * Get API key from environment
   */
  getApiKey(): string | undefined {
    return (
      this.env.ANTHROPIC_API_KEY ||
      this.env.CLAUDE_CODE_OAUTH_TOKEN ||
      this.env.ANTHROPIC_AUTH_TOKEN ||
      (this.credentials?.type === 'api_key' ? this.credentials.apiKey : undefined) ||
      (this.credentials?.type === 'oauth' ? this.credentials.accessToken : undefined)
    );
  }

  async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
    const apiKey = this.getApiKey();
    return {
      isAuthenticated: !!apiKey,
      method: this.credentials?.type ?? 'api_key',
      error: apiKey ? undefined : 'Set ANTHROPIC_API_KEY or log in with Claude Code OAuth.',
    };
  }

  async shutdown(): Promise<void> {}

  /**
   * Get available models from Anthropic
   * Dynamically loads from SDK - no static fallback
   */
  async getModels(): Promise<ModelInfo[]> {
    // Return cached models if available
    if (this.modelCache) {
      return this.modelCache;
    }

    // Only try to load from SDK if credentials are available
    // Without credentials, the SDK call may hang indefinitely
    if (!this.isAvailable()) {
      return [];
    }

    try {
      // Load from SDK
      const models = await this.loadModelsFromSdk();
      this.modelCache = models;
      return models;
    } catch {
      // No static fallback - return empty array
      return [];
    }
  }

  /**
   * Load models from SDK
   * @param timeout - Timeout in milliseconds (default: 3000ms)
   */
  private async loadModelsFromSdk(timeout: number = 10000): Promise<ModelInfo[]> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const env = this.buildSdkConfig().envVars;
    const restoreEnv = this.applyEnvVarsForSdk(env);

    try {
      // Create a temporary query to fetch models
      const tmpQuery = query({
        prompt: '',
        options: {
          model: 'default',
          cwd: process.cwd(),
          maxTurns: 0,
          pathToClaudeCodeExecutable: resolveSDKCliPath(),
          executable: isRunningUnderBun() ? 'bun' : undefined,
          settings: withSdkTranscriptRetention(),
        },
      });

      try {
        // Add timeout to prevent hanging in CI/slow environments
        const sdkModels = await Promise.race([
          tmpQuery.supportedModels(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('SDK model load timeout')), timeout)
          ),
        ]);
        return this.convertSdkModels(sdkModels);
      } finally {
        // Fire-and-forget interrupt
        tmpQuery.interrupt().catch(() => {});
      }
    } finally {
      restoreEnv();
    }
  }

  /**
   * Convert SDK models to ModelInfo format
   * Public for use by external helpers like getAnthropicModelsFromQuery
   *
   * Intelligently filters out duplicate models:
   * - Prefers canonical short IDs (sonnet, opus, haiku) over full version IDs
   * - Detects when multiple IDs represent the same model
   */
  convertSdkModels(
    sdkModels: Array<{ value: string; displayName: string; description: string }>
  ): ModelInfo[] {
    // Defensive filter: drop any SDK model IDs that do not belong to Anthropic.
    // The SDK targets whatever ANTHROPIC_BASE_URL points at, so a stale env
    // override (e.g. left over from a GLM session) can cause foreign model
    // IDs to appear here. Tagging them as `provider: 'anthropic'` would make
    // GLM/other-provider models show up under the Anthropic group in the UI.
    sdkModels = sdkModels.filter((m) => isAnthropicSdkModelId(m.value));

    // Track which model families we've seen with canonical IDs
    const canonicalIdsByFamily = new Map<string, string>();

    // First pass: identify all canonical IDs and extract versions from descriptions
    for (const sdkModel of sdkModels) {
      if (CANONICAL_SDK_IDS.has(sdkModel.value)) {
        const parsed = parseModelId(sdkModel.value, sdkModel.description);
        if (parsed && parsed.version) {
          const key = `${parsed.family}-${parsed.version}`;
          canonicalIdsByFamily.set(key, sdkModel.value);
        }
      }
    }

    return sdkModels
      .filter((sdkModel) => {
        // Always keep canonical short IDs
        if (CANONICAL_SDK_IDS.has(sdkModel.value)) {
          return true;
        }

        // For full version IDs, check if there's a canonical ID for the same model
        if (isFullVersionId(sdkModel.value)) {
          const parsed = parseModelId(sdkModel.value, sdkModel.description);
          if (parsed && parsed.version) {
            const key = `${parsed.family}-${parsed.version}`;
            const canonicalId = canonicalIdsByFamily.get(key);

            if (canonicalId) {
              // There's a canonical ID for this model - filter out the full ID
              return false;
            }
          }
        }

        // Keep all other models
        return true;
      })
      .map((sdkModel) => {
        // Convert SDK's 'default' to 'sonnet' for consistency
        const modelId = sdkModel.value === 'default' ? 'sonnet' : sdkModel.value;

        // Extract display name from description (format: "Model X.Y · description")
        const description = sdkModel.description || '';
        const separatorIndex = description.indexOf(' · ');
        let displayName = description;
        if (separatorIndex > 0) {
          displayName = description.substring(0, separatorIndex);
        } else {
          displayName = sdkModel.displayName || sdkModel.value;
        }

        // Handle SDK's verbose default model display name
        const currentlyMatch = displayName.match(/currently\s+([^)]+)/);
        if (currentlyMatch) {
          displayName = currentlyMatch[1].trim();
        }

        // Determine family from model ID or display name
        let family: 'opus' | 'sonnet' | 'haiku' | 'fable' = 'sonnet';
        const nameLower = displayName.toLowerCase();
        if (nameLower.includes('opus')) {
          family = 'opus';
        } else if (nameLower.includes('haiku')) {
          family = 'haiku';
        } else if (nameLower.includes('fable')) {
          family = 'fable';
        }

        return {
          id: modelId,
          name: displayName,
          alias: modelId, // Use 'sonnet' instead of 'default'
          family,
          provider: 'anthropic',
          contextWindow: 200000,
          description: sdkModel.description || '',
          releaseDate: '',
          available: true,
        };
      });
  }

  /**
   * Check if a model ID belongs to Anthropic
   *
   * Anthropic owns:
   * - 'sonnet', 'opus', 'haiku' (SDK short IDs)
   * - 'claude-*' model IDs
   *
   * Does NOT own models from other providers (glm-*, deepseek-*, etc.)
   */
  ownsModel(modelId: string): boolean {
    const lower = modelId.toLowerCase();

    // SDK short IDs
    if (['sonnet', 'opus', 'haiku', 'fable'].includes(lower)) {
      return true;
    }

    // Legacy: 'default' maps to sonnet
    if (lower === 'default') {
      return true;
    }

    // Anthropic model IDs
    if (lower.startsWith('claude-')) {
      return true;
    }

    // Known other provider prefixes (exclude these).
    // Even if no provider is currently registered for openai-/gpt-/copilot- prefixes,
    // keeping them here prevents Anthropic from claiming those model IDs by default,
    // which would cause confusing "model not found" errors from the Anthropic API.
    const otherProviderPrefixes = [
      'glm-',
      'deepseek-',
      'openai-',
      'gpt-',
      'qwen-',
      'copilot-',
      'minimax-',
    ];
    if (otherProviderPrefixes.some((prefix) => lower.startsWith(prefix))) {
      return false;
    }

    // Default: assume Anthropic for unknown models
    // (this allows legacy model IDs to work)
    return true;
  }

  /**
   * Get model for a specific tier
   */
  getModelForTier(tier: ModelTier): string | undefined {
    const tierMap: Record<ModelTier, string> = {
      sonnet: 'sonnet',
      haiku: 'haiku',
      opus: 'opus',
      default: 'sonnet',
    };
    return tierMap[tier];
  }

  /**
   * Build SDK configuration for Anthropic
   *
   * Anthropic uses default SDK behavior - no special config needed.
   * Returns empty env vars (SDK handles auth from environment).
   */
  buildSdkConfig(): ProviderSdkConfig {
    const envVars: Record<string, string> = {};
    const hasEnvAuth =
      !!this.env.ANTHROPIC_API_KEY ||
      !!this.env.CLAUDE_CODE_OAUTH_TOKEN ||
      (!!this.env.ANTHROPIC_AUTH_TOKEN &&
        !this.env.ANTHROPIC_AUTH_TOKEN.startsWith('anthropic-copilot-proxy:'));
    if (!hasEnvAuth && this.credentials?.type === 'api_key') {
      envVars.ANTHROPIC_API_KEY = this.credentials.apiKey;
    } else if (!hasEnvAuth && this.credentials?.type === 'oauth' && this.credentials.accessToken) {
      envVars.CLAUDE_CODE_OAUTH_TOKEN = this.credentials.accessToken;
    }

    return {
      envVars,
      isAnthropicCompatible: true,
      apiVersion: 'v1',
    };
  }

  private applyEnvVarsForSdk(envVars: Record<string, string>): () => void {
    const originals = new Map<string, string | undefined>();

    // Clear stale routing vars from other providers (e.g. Copilot) so the SDK
    // talks to the real Anthropic API, not an embedded proxy.
    // Preserve user-configured ANTHROPIC_BASE_URL (captured at construction).
    if (process.env.ANTHROPIC_BASE_URL !== undefined) {
      if (process.env.ANTHROPIC_BASE_URL !== this.capturedAnthropicBaseUrl) {
        originals.set('ANTHROPIC_BASE_URL', process.env.ANTHROPIC_BASE_URL);
        delete process.env.ANTHROPIC_BASE_URL;
      }
    }
    // Only clear ANTHROPIC_AUTH_TOKEN when it is a known provider-routing token
    // (Copilot sets it to 'anthropic-copilot-proxy:<workspace>'). Preserve real
    // user auth tokens so model loading succeeds for ANTHROPIC_AUTH_TOKEN users.
    if (process.env.ANTHROPIC_AUTH_TOKEN?.startsWith('anthropic-copilot-proxy:')) {
      originals.set('ANTHROPIC_AUTH_TOKEN', process.env.ANTHROPIC_AUTH_TOKEN);
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }

    for (const [key, value] of Object.entries(envVars)) {
      originals.set(key, process.env[key]);
      process.env[key] = value;
    }

    return () => {
      for (const [key, value] of originals) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };
  }

  /**
   * Set model cache
   * Useful for pre-warming the cache from external model loading
   */
  setModelCache(models: ModelInfo[]): void {
    this.modelCache = models;
  }

  /**
   * Clear model cache
   */
  clearModelCache(): void {
    this.modelCache = null;
  }
}

/**
 * Helper function to get models from an existing query
 * This is useful for getting models from an active session's query
 */
export async function getAnthropicModelsFromQuery(
  queryObject: QueryLike | null
): Promise<ModelInfo[]> {
  if (!queryObject || typeof queryObject.supportedModels !== 'function') {
    return [];
  }

  const provider = new AnthropicProvider();
  try {
    const sdkModels = await queryObject.supportedModels();
    return provider.convertSdkModels(sdkModels);
  } catch {
    return [];
  }
}
