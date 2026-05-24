/**
 * Settings types for NeoKai
 *
 * This module defines the settings system types that support both SDK-native
 * settings (passed as query options) and file-only settings (written to
 * .claude/settings.local.json).
 */

import type { ThinkingLevel } from '../types.ts';
import type { CustomEndpointConfig } from './custom-endpoint.ts';

export type SettingSource = 'user' | 'project' | 'local';

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';

/**
 * Settings that can be passed to the SDK via query options
 */
export interface SDKSupportedSettings {
  // Model
  model?: string;

  // Permissions
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  additionalDirectories?: string[];

  // Thinking
  maxThinkingTokens?: number | null;

  // Environment
  env?: Record<string, string>;

  // Limits
  maxTurns?: number;
  maxBudgetUsd?: number;

  // Sandbox
  sandbox?: {
    enabled?: boolean;
    autoAllowBashIfSandboxed?: boolean;
    excludedCommands?: string[];
    allowUnsandboxedCommands?: boolean;
    network?: {
      allowUnixSockets?: string[];
      allowLocalBinding?: boolean;
      allowedDomains?: string[];
      allowAllUnixSockets?: boolean;
      httpProxyPort?: number;
      socksProxyPort?: number;
    };
  };

  // Betas
  betas?: Array<'context-1m-2025-08-07'>;

  // System prompt
  systemPrompt?: string;
}

/**
 * Settings that can only be configured via .claude/settings.local.json
 * These settings have no SDK option equivalent.
 *
 * NOTE: Legacy MCP toggles (disabledMcpServers, enabledMcpServers,
 * enableAllProjectMcpServers) were removed in M5. The unified `app_mcp_servers`
 * registry plus the `mcp_enablement` override table is now the only place MCP
 * enablement is recorded; NeoKai no longer writes the SDK's
 * `disabledMcpjsonServers` / `enabledMcpjsonServers` /
 * `enableAllProjectMcpServers` keys into `.claude/settings.local.json`.
 */
export interface FileOnlySettings {
  // Permissions (file-only features)
  askPermissions?: string[];

  // Sandbox (file-only features)
  excludedCommands?: string[];
  allowUnsandboxedCommands?: boolean;

  // UI/Display
  outputStyle?: string;
  showArchived?: boolean;

  // Attribution
  attribution?: {
    commit?: string;
    pr?: string;
  };

  // Output Limiter (NeoKai-specific)
  outputLimiter?: {
    enabled?: boolean;
    bash?: {
      headLines?: number; // First N lines to show (default: 100)
      tailLines?: number; // Last N lines to show (default: 200)
    };
    read?: {
      maxChars?: number; // Max characters to read (default: 50000)
    };
    grep?: {
      maxMatches?: number; // Max search matches (default: 500)
    };
    glob?: {
      maxFiles?: number; // Max files to list (default: 1000)
    };
    excludeTools?: string[]; // Tools to exclude from limiting
  };
}

/**
 * A single fallback model entry in the fallback chain.
 * Used when the primary model fails due to rate limits or usage limits.
 */
export interface FallbackModelEntry {
  /** Model ID (e.g., 'claude-sonnet-4-5-20250929') */
  model: string;
  /** Provider ID (e.g., 'anthropic', 'glm', 'minimax') */
  provider: string;
}

/**
 * Global settings that apply across all sessions
 */
export interface GlobalSettings extends SDKSupportedSettings, FileOnlySettings {
  // Setting sources to load (all enabled by default)
  settingSources: SettingSource[];

  /**
   * Optional per-provider model allowlists. When a provider has entries here,
   * model selection UIs and runtime validation only allow the listed model IDs.
   * This is needed for providers such as OpenRouter where account-enabled model
   * restrictions are configured in the provider dashboard but are not exposed by
   * the provider's public models API.
   */
  providerModelAllowlists?: Record<string, string[]>;

  // Default thinking level for new sessions
  // Maps to maxThinkingTokens in SDK options
  thinkingLevel?: ThinkingLevel;

  // Default auto-scroll setting for new sessions
  autoScroll?: boolean;

  // Default coordinator mode for new sessions
  coordinatorMode?: boolean;

  // Room agent settings
  /** Maximum number of concurrent worker sessions per room agent (default: 3) */
  maxConcurrentWorkers?: number;

  /** Ordered fallback model chain for automatic model switching on rate/usage limits */
  fallbackModels?: FallbackModelEntry[];

  /**
   * Model-specific fallback mappings. When a model hits a rate/usage limit,
   * its entry here takes priority over the default `fallbackModels` list.
   * Keys are `"provider/model"` strings (e.g. `"anthropic/claude-sonnet-4-20250514"`).
   * Values are ordered fallback chains, same format as `fallbackModels`.
   */
  modelFallbackMap?: Record<string, FallbackModelEntry[]>;

  /**
   * User-defined OpenAI-compatible API endpoints. Each entry registers a
   * provider with id `custom:<endpoint.id>` at daemon startup. See
   * `CustomEndpointConfig` and `CustomEndpointProvider`.
   */
  customEndpoints?: CustomEndpointConfig[];
}

/**
 * Session-specific settings that can override global settings
 */
export interface SessionSettings extends GlobalSettings {
  sessionId: string;
}

/**
 * Default global settings
 */
export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  settingSources: ['user', 'project', 'local'],
  permissionMode: 'default',
  model: 'sonnet', // Default model for new sessions
  showArchived: false,
  // Default auto-scroll to true so new sessions inherit this setting
  // This must match the display default in GlobalSettingsEditor (autoScroll ?? true)
  autoScroll: true,
  // Default coordinator mode to false (user opts in when needed)
  coordinatorMode: false,
  // Room agent: default to 3 concurrent workers
  maxConcurrentWorkers: 3,
  // Sandbox: Enable with balanced network permissions for development
  // Provides filesystem isolation while allowing common development operations
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    excludedCommands: ['git'], // Git runs outside sandbox for SSH, submodules, LFS, various git hosts
    network: {
      // Allow outbound network to common development domains (git, npm, pip, etc.)
      allowedDomains: [
        'github.com',
        '*.github.com',
        'gist.github.com',
        '*.npmjs.org',
        'registry.npmjs.org',
        '*.yarnpkg.com',
        'registry.yarnpkg.com',
        'packages.gitlab.com',
        '*.pkg.dev',
        'go.dev',
        'crates.io',
        'pypi.org',
        '*.pypi.org',
        'rubygems.org',
        '*.rubygems.org',
        '*.maven.org',
        '*.gradle.org',
        'cdn.jsdelivr.net',
        '*.cloudflare.com',
        // AI provider APIs
        'openai.com',
        '*.openai.com',
        'anthropic.com',
        '*.anthropic.com',
        'openrouter.ai',
        '*.openrouter.ai',
        // Google AI & Cloud services
        '*.google.dev',
        '*.google.com',
        '*.googleapis.com',
        '*.googleusercontent.com',
        '*.gcp.goog',
        '*.run.app',
        '*.appspot.com',
        '*.cloudfunctions.net',
        // Other AI providers
        'cohere.com',
        '*.cohere.com',
        'mistral.ai',
        '*.mistral.ai',
        'huggingface.co',
        '*.huggingface.co',
        'replicate.com',
        '*.replicate.com',
        'together.ai',
        '*.together.ai',
        'api.together.xyz',
        'groq.com',
        '*.groq.com',
      ],
      // Allow binding to localhost for dev servers (vite, webpack, etc.)
      allowLocalBinding: true,
      // Allow SSH agent and other Unix sockets
      allowAllUnixSockets: true,
    },
  },
  outputLimiter: {
    enabled: true,
    bash: {
      headLines: 100,
      tailLines: 200,
    },
    read: {
      maxChars: 50000,
    },
    grep: {
      maxMatches: 500,
    },
    glob: {
      maxFiles: 1000,
    },
    excludeTools: [],
  },
};

/**
 * MCP server information
 */
export interface McpServerInfo {
  name: string;
  status: 'connected' | 'failed' | 'pending' | 'disabled';
  enabled: boolean;
  description?: string;
}
