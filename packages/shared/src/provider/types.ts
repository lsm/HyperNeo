/**
 * Multi-Provider Architecture - Type Definitions
 *
 * This file defines the interfaces and types for the new provider system.
 * Each provider implements the Provider interface to enable multi-provider support.
 */

import type { ModelInfo } from '../models.js';

/**
 * Model tier identifiers used for mapping generic tiers to provider-specific models
 */
export type ModelTier = 'sonnet' | 'haiku' | 'opus' | 'default';

/**
 * Provider identifier - any string to allow extensibility
 */
export type ProviderId = string;

/**
 * Provider capabilities describe what features a provider supports
 */
export interface ProviderCapabilities {
  /** Supports streaming responses */
  streaming: boolean;
  /** Supports extended thinking */
  extendedThinking: boolean;
  /** Thinking mode: 'off' = none, 'on' = binary, 'granular' = token budgets */
  thinkingModes: 'off' | 'on' | 'granular';
  /** Maximum context window in tokens */
  maxContextWindow: number;
  /** Supports function calling / tool use */
  functionCalling: boolean;
  /** Supports vision (image inputs) */
  vision: boolean;
}

/**
 * SDK configuration returned by a provider
 * Contains environment variables and SDK options needed to use this provider
 */
export interface ProviderSdkConfig {
  /** Environment variables to set before creating SDK query */
  envVars: Record<string, string>;
  /** Additional SDK options to merge */
  sdkOptions?: Record<string, unknown>;
  /** Whether this provider uses Anthropic-compatible API */
  isAnthropicCompatible: boolean;
  /** API version (if applicable) */
  apiVersion?: string;
}

/**
 * Per-session provider configuration
 * Allows overriding API keys, base URLs, etc. for a specific session
 */
export interface ProviderSessionConfig {
  /** Provider-specific API key override */
  apiKey?: string;
  /** Custom base URL override */
  baseUrl?: string;
  /** Workspace/working directory for this session (used for workspace-scoped providers) */
  workspacePath?: string;
  /** Session ID for provider-aware routing (e.g. persistent session tracking) */
  sessionId?: string;
  /** Additional provider-specific settings */
  [key: string]: unknown;
}

/**
 * Authentication status returned by providers
 */
export interface ProviderAuthStatusInfo {
  /** Whether the provider is authenticated */
  isAuthenticated: boolean;
  /** Authentication method used */
  method?: 'api_key' | 'oauth';
  /** Token expiration timestamp (Unix ms) */
  expiresAt?: number;
  /** Whether token needs refresh */
  needsRefresh?: boolean;
  /** User information (if available) */
  user?: {
    email?: string;
    name?: string;
  };
  /** Error message if authentication failed */
  error?: string;
}

/**
 * OAuth flow data returned when starting OAuth
 */
export interface ProviderOAuthFlowData {
  /** Flow type: redirect (browser) or device (code entry) */
  type: 'redirect' | 'device';
  /** For redirect flow: URL to open in browser */
  authUrl?: string;
  /** For device flow: user code to display */
  userCode?: string;
  /** For device flow: verification URL */
  verificationUri?: string;
  /** Human-readable message */
  message: string;
}

/**
 * Core provider interface that all providers must implement
 *
 * This interface enables:
 * - Dynamic provider registration
 * - Provider-specific model management
 * - Isolated configuration without global state mutation
 * - Easy addition of new providers
 */
export interface Provider {
  /**
   * Unique provider identifier
   * Used in SessionConfig.provider and ModelInfo.provider
   */
  readonly id: ProviderId;

  /**
   * Human-readable display name
   * Shown in UI for provider selection
   */
  readonly displayName: string;

  /**
   * Provider capabilities
   * Describes what features this provider supports
   */
  readonly capabilities: ProviderCapabilities;

  /**
   * Check if provider is available (has valid credentials)
   * Can be synchronous (check env vars) or asynchronous (validate API key)
   */
  isAvailable(): Promise<boolean> | boolean;

  /**
   * Get list of available models from this provider
   * Can be static (from config) or dynamic (API call)
   */
  getModels(): Promise<ModelInfo[]>;

  /**
   * Validate that a model ID belongs to this provider
   * Used for auto-detecting provider from model ID
   */
  ownsModel(modelId: string): boolean;

  /**
   * Get the model to use for a specific tier
   * Maps generic tiers (sonnet/haiku/opus) to provider-specific models
   * Returns undefined if provider doesn't have a model for that tier
   */
  getModelForTier(tier: ModelTier): string | undefined;

  /**
   * Build SDK configuration for this provider
   * Returns env vars and SDK options needed to use this provider
   *
   * @param modelId - The model ID to use
   * @param sessionConfig - Optional per-session configuration overrides
   */
  buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig;

  /**
   * Translate a provider model ID to SDK-compatible ID if needed
   * Some providers (like GLM) need to translate their model IDs to Anthropic tiers
   *
   * @param modelId - The provider's model ID
   * @returns SDK-compatible model ID (or original if no translation needed)
   */
  translateModelIdForSdk?(modelId: string): string;

  /**
   * Optional: Get authentication status for this provider.
   * Returns detailed auth info including method, expiration, and user info.
   */
  getAuthStatus?(): Promise<ProviderAuthStatusInfo>;

  /**
   * Optional: Start OAuth authentication flow.
   * Returns flow data (URL for redirect, or code for device flow).
   * The auth completes asynchronously - poll getAuthStatus() to check completion.
   */
  startOAuthFlow?(): Promise<ProviderOAuthFlowData>;

  /**
   * Optional: Logout from this provider.
   * Clears stored credentials.
   */
  logout?(): Promise<void>;

  /**
   * Optional: Refresh authentication token for this provider.
   * Used when token has expired and needs refresh without full logout/login.
   * Returns true if refresh succeeded, false otherwise.
   */
  refreshToken?(): Promise<boolean>;

  /**
   * Optional: Shut down any resources held by this provider (e.g. an embedded
   * HTTP server). Called during daemon shutdown so the event loop can exit.
   */
  shutdown?(): Promise<void>;

  /**
   * Optional: Clear this provider's model cache so the next getModels()
   * call re-fetches from the API instead of returning stale cached data.
   */
  clearModelCache?(): void;

  /**
   * Optional: Return the thinking mode supported by a specific model, when
   * the provider exposes models with heterogeneous thinking capability.
   * Used by the query-options builder to skip emitting `thinking` payloads
   * for models that don't support extended thinking, even when the
   * provider-level aggregate capability advertises `on`/`granular`.
   *
   * Returning `undefined` means "fall back to the provider-level
   * `capabilities.thinkingModes`". Returning `'off'` explicitly suppresses
   * thinking for this model.
   */
  getModelThinkingMode?(modelId: string): 'off' | 'on' | 'granular' | undefined;
}

/**
 * Provider context created for a session
 * Encapsulates provider-specific configuration for query building
 */
export interface ProviderContext {
  /** The provider instance */
  readonly provider: Provider;
  /** SDK configuration for this provider/context */
  readonly sdkConfig: ProviderSdkConfig;
  /** The original model ID (provider-specific) */
  readonly modelId: string;
  /** Session-specific config (may have API key override) */
  readonly sessionConfig?: ProviderSessionConfig;

  /**
   * Get the SDK-compatible model ID
   * Applies translation if provider needs it
   */
  getSdkModelId(): string;

  /**
   * Build SDK options with provider configuration applied
   * Merges base options with provider-specific env vars and settings
   */
  buildSdkOptions<T extends Record<string, unknown>>(baseOptions: T): Promise<T>;
}

/**
 * Provider information for UI display
 */
export interface ProviderInfo {
  /** Provider identifier */
  id: ProviderId;
  /** Display name */
  name: string;
  /** Whether this provider is configured (has API key) */
  available: boolean;
  /** Capabilities */
  capabilities: ProviderCapabilities;
  /** Available model IDs */
  models: string[];
}
