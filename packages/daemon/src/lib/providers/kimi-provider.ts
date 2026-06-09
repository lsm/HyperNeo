/**
 * Kimi Provider - Moonshot AI（月之暗面）
 *
 * Kimi Code exposes a native Anthropic-compatible API at
 * https://api.kimi.com/coding/ — designed for coding agents.
 *
 * The API uses a single fixed model ID `kimi-for-coding` that automatically
 * maps to the latest Kimi flagship model.
 *
 * ## Bridge architecture
 *
 * The Claude Agent SDK has a hardcoded table of known model context windows.
 * It does not recognise `kimi-for-coding` and falls back to a ~200 k default,
 * rejecting requests that fit within Kimi's 262 k window.  To work around
 * this, the provider routes SDK traffic through a lightweight local bridge that
 * intercepts `GET /v1/models` and returns the correct context window metadata.
 * All other requests are proxied verbatim to Kimi's API — no protocol
 * translation is needed.
 *
 * API Documentation: https://www.kimi.com/code/docs/
 */

import type {
  Provider,
  ProviderAuthStatusInfo,
  ProviderCapabilities,
  ProviderCredentials,
  ProviderSdkConfig,
  ProviderSessionConfig,
  ModelTier,
} from '@neokai/shared/provider';
import type { ModelInfo } from '@neokai/shared';
import {
  createAnthropicMessagesBridgeServer,
  type AnthropicMessagesBridgeServer,
} from './anthropic-messages-bridge/server.js';
import { Logger } from '../logger.js';
import * as crypto from 'crypto';

const logger = new Logger('kimi-provider');

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Return a short non-reversible fingerprint of `value` for log correlation. */
function keyFingerprint(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export class KimiProvider implements Provider {
  readonly id = 'kimi';
  readonly displayName = 'Kimi (Moonshot AI)';

  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    extendedThinking: true,
    thinkingModes: 'on',
    maxContextWindow: 262144,
    functionCalling: true,
    vision: false,
  };

  /** Anthropic-compatible base URL for Kimi Code. */
  static readonly BASE_URL = 'https://api.kimi.com/coding';
  /** OpenAI-compatible base URL for Kimi Code. */
  static readonly OPENAI_BASE_URL = 'https://api.kimi.com/coding/v1';
  /**
   * Fixed model ID that automatically maps to the latest Kimi flagship model.
   * See https://www.kimi.com/code/docs/ — "统一使用模型 ID kimi-for-coding"
   */
  static readonly DEFAULT_MODEL = 'kimi-for-coding';

  static readonly MODELS: ModelInfo[] = [
    {
      id: 'kimi-for-coding',
      name: 'Kimi For Coding',
      alias: 'kimi',
      family: 'kimi',
      provider: 'kimi',
      contextWindow: 262144,
      description:
        'Kimi Code model (auto-upgrades to latest flagship). Fixed model ID for all requests.',
      releaseDate: '',
      available: true,
    },
  ];

  private readonly env: NodeJS.ProcessEnv;
  private credentials: ProviderCredentials | null = null;

  /**
   * Bridge servers keyed by `{baseUrl}::{apiKey}` so that sessions with
   * different per-session credentials get isolated bridges that forward
   * the correct auth upstream.  This avoids a singleton bridge leaking
   * one session's credentials into another session's requests.
   */
  private readonly bridgeServers = new Map<string, AnthropicMessagesBridgeServer>();

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly bridgeFactory: typeof createAnthropicMessagesBridgeServer = createAnthropicMessagesBridgeServer
  ) {
    this.env = env;
  }

  setCredentials(credentials: ProviderCredentials): void {
    this.credentials = credentials;
  }

  getCredentials(): ProviderCredentials | null {
    return this.credentials;
  }

  isAvailable(): boolean {
    return !!this.getApiKey();
  }

  getApiKey(): string | undefined {
    return (
      this.env.KIMI_API_KEY?.trim() ||
      this.env.MOONSHOT_API_KEY?.trim() ||
      (this.credentials?.type === 'api_key' ? this.credentials.apiKey : undefined)
    );
  }

  async getModels(): Promise<ModelInfo[]> {
    return this.isAvailable() ? KimiProvider.MODELS : [];
  }

  ownsModel(modelId: string): boolean {
    const id = modelId.toLowerCase();
    return id === 'kimi' || id === 'kimi-for-coding' || id.startsWith('moonshot-');
  }

  getModelForTier(_tier: ModelTier): string | undefined {
    return KimiProvider.DEFAULT_MODEL;
  }

  buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig {
    const apiKey = sessionConfig?.apiKey || this.getApiKey();
    if (!apiKey) {
      throw new Error('Kimi API key not configured. Set KIMI_API_KEY or MOONSHOT_API_KEY.');
    }

    const baseUrl = normalizeBaseUrl(sessionConfig?.baseUrl || KimiProvider.BASE_URL);
    // All Kimi Code requests use the fixed model ID
    const routingModelId = KimiProvider.DEFAULT_MODEL;

    // Lazily start a per-credentials bridge.  Keyed by `{baseUrl}::{apiKey}`
    // so sessions with different API keys or base URLs get isolated bridges
    // that forward the correct auth upstream.
    const bridgeKey = `${baseUrl}::${apiKey}`;
    let bridgeServer = this.bridgeServers.get(bridgeKey);
    if (!bridgeServer) {
      bridgeServer = this.bridgeFactory({
        baseUrl,
        apiKey,
        models: [
          {
            id: routingModelId,
            display_name: 'Kimi For Coding',
            context_window: 262144,
            max_tokens: 32768,
          },
        ],
      });
      this.bridgeServers.set(bridgeKey, bridgeServer);
      // Log a fingerprint, not the raw key — avoids leaking credential prefixes
      // in daemon logs.
      const logKey = `${baseUrl}::${keyFingerprint(apiKey)}`;
      logger.info(`Kimi bridge server started on port ${bridgeServer.port} for key=${logKey}`);
    }

    return {
      envVars: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${bridgeServer.port}`,
        // Blank ANTHROPIC_API_KEY explicitly so ProviderService clears any
        // inherited Anthropic key from process.env. The bridge handles Kimi
        // auth via its config.apiKey; no ANTHROPIC_AUTH_TOKEN needed.
        ANTHROPIC_API_KEY: '',
        API_TIMEOUT_MS: '3000000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: routingModelId,
        ANTHROPIC_DEFAULT_SONNET_MODEL: routingModelId,
        ANTHROPIC_DEFAULT_OPUS_MODEL: routingModelId,
      },
      isAnthropicCompatible: true,
      apiVersion: 'v1',
    };
  }

  translateModelIdForSdk(_modelId: string): string {
    return 'default';
  }

  getTitleGenerationModel(): string {
    return KimiProvider.DEFAULT_MODEL;
  }

  async getAuthStatus(): Promise<ProviderAuthStatusInfo> {
    const apiKey = this.getApiKey();
    return {
      isAuthenticated: !!apiKey,
      method: 'api_key',
      error: apiKey ? undefined : 'Set KIMI_API_KEY or MOONSHOT_API_KEY to enable Kimi models.',
    };
  }

  async shutdown(): Promise<void> {
    for (const [key, server] of this.bridgeServers) {
      server.stop();
      const [baseUrl, apiKey] = key.split('::');
      const logKey = `${baseUrl}::${keyFingerprint(apiKey)}`;
      logger.info(`Kimi bridge server stopped for key=${logKey}`);
    }
    this.bridgeServers.clear();
  }
}
